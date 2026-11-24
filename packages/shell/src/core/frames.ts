/**
 * App frames (Phase 3 §10): the bridge between ONE sandboxed app iframe and the
 * connection to the Pi.
 *
 * Trust model: the frame is third-party code with an opaque origin, so its
 * `postMessage` origin means nothing. Identity comes from the OBJECT:
 *  - a hello is accepted only if `event.source === iframe.contentWindow`,
 *    only once, and only while the frame has loaded exactly one page
 *  - a second `load` (the page navigated) destroys the frame and its port
 *  - every request is forwarded with `app` set by the SHELL to this frame's app;
 *    the page cannot name an app and cannot reach control ops at all
 *  - per-frame size and rate limits
 */
import { FRAME_LIMITS, PageMessageSchema, PORT_HANDOFF, PORT_HELLO, PORT_PROTOCOL_VERSION, type PortError, type ShellMessage } from '@pifi/protocol/browser';
import type { ConnStatus } from './connection.js';
import { isShellError } from './errors.js';
import { RequestError, type ShellStream, type WireClient } from './wireClient.js';

/** The bits of an <iframe> the bridge needs (real elements satisfy this). */
export interface FrameLike {
  readonly contentWindow: { postMessage(msg: unknown, targetOrigin: string, transfer?: Transferable[]): void } | null;
  addEventListener(type: 'load', cb: () => void): void;
  remove(): void;
}

export interface FrameBridgeOptions {
  app: string;
  frame: FrameLike;
  /** The live wire client, or undefined while reconnecting. */
  client: () => WireClient | undefined;
  onStatus: (cb: (s: ConnStatus) => void) => () => void;
  onDestroyed?: (reason: string) => void;
  now?: () => number;
}

function portError(err: unknown): PortError {
  if (err instanceof RequestError) return { code: err.code, message: err.message };
  if (isShellError(err)) return { code: err.code, message: err.message };
  return { code: 'INTERNAL', message: 'request failed' };
}

/** The sandbox the shell must use. Never allow-same-origin / allow-top-navigation / allow-popups. */
export const FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads';

export class FrameBridge {
  private loads = 0;
  private port?: MessagePort;
  private handedOff = false;
  private destroyed = false;
  private tokens: number = FRAME_LIMITS.BURST;
  private lastRefill: number;
  private subscribed = false;
  private offEvents?: () => void;
  private offStatus?: () => void;
  private readonly streams = new Map<number, ShellStream>();
  private readonly now: () => number;

  constructor(private readonly o: FrameBridgeOptions) {
    this.now = o.now ?? Date.now;
    this.lastRefill = this.now();
    o.frame.addEventListener('load', () => {
      this.loads++;
      // Navigation guard: a second load means the page we consented to is gone.
      if (this.loads > 1) this.destroy('the app page tried to navigate away');
    });
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Call for EVERY window `message` event; the bridge decides whether it is for it. */
  onWindowMessage(ev: { source: unknown; data: unknown }): void {
    if (this.destroyed || this.handedOff) return;
    if (ev.source !== this.o.frame.contentWindow || ev.source === null) return; // identity by object
    if (this.loads !== 1) return;
    const d = ev.data as { t?: unknown; v?: unknown } | null;
    if (!d || d.t !== PORT_HELLO || d.v !== PORT_PROTOCOL_VERSION) return;
    this.handedOff = true;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (e) => this.onPortMessage(e.data);
    // The frame's origin is opaque, so "*" is the only possible target. Identity came from `source`.
    this.o.frame.contentWindow?.postMessage({ t: PORT_HANDOFF, v: PORT_PROTOCOL_VERSION }, '*', [channel.port2]);
    this.offStatus = this.o.onStatus((s) => this.post({ t: 'status', status: s.state === 'online' ? 'online' : 'reconnecting' }));
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const s of this.streams.values()) s.abort('frame closed');
    this.streams.clear();
    if (this.subscribed) this.o.client()?.unsubscribe(this.o.app);
    this.offEvents?.();
    this.offStatus?.();
    this.port?.close();
    this.o.frame.remove();
    this.o.onDestroyed?.(reason);
  }

  // -------------------------------------------------------------------------

  private post(msg: ShellMessage, transfer: Transferable[] = []): void {
    if (!this.destroyed) this.port?.postMessage(msg, transfer);
  }

  private takeToken(): boolean {
    const t = this.now();
    this.tokens = Math.min(FRAME_LIMITS.BURST, this.tokens + ((t - this.lastRefill) / 1000) * FRAME_LIMITS.REQUESTS_PER_SEC);
    this.lastRefill = t;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  private onPortMessage(raw: unknown): void {
    if (this.destroyed) return;
    const parsed = PageMessageSchema.safeParse(raw);
    if (!parsed.success) return; // ignore junk; a page can't do anything with malformed messages
    const msg = parsed.data;
    if (msg.t !== 's.data') {
      let size = Infinity;
      try { size = JSON.stringify(msg).length; } catch { /* not serialisable */ }
      if (size > FRAME_LIMITS.MAX_MESSAGE_BYTES) {
        if (msg.t === 'req') this.post({ t: 'res', id: msg.id, ok: false, error: { code: 'TOO_LARGE', message: 'message over 64 KiB' } });
        return;
      }
      if (!this.takeToken()) {
        if (msg.t === 'req') this.post({ t: 'res', id: msg.id, ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } });
        return;
      }
    }
    const client = this.o.client();
    switch (msg.t) {
      case 'req': {
        if (!client) return this.post({ t: 'res', id: msg.id, ok: false, error: { code: 'DISCONNECTED', message: 'not connected to the Pi' } });
        // `app` comes from the frame, never from the message.
        client.request(msg.op, msg.payload, { app: this.o.app }).then(
          (payload) => this.post({ t: 'res', id: msg.id, ok: true, payload }),
          (err) => this.post({ t: 'res', id: msg.id, ok: false, error: portError(err) }),
        );
        return;
      }
      case 'sub':
        if (this.subscribed || !client) return;
        this.subscribed = true;
        client.subscribe(this.o.app);
        this.offEvents = client.onEvent((app, name, data) => { if (app === this.o.app) this.post({ t: 'evt', name, data }); });
        return;
      case 'unsub':
        if (!this.subscribed) return;
        this.subscribed = false;
        this.offEvents?.();
        client?.unsubscribe(this.o.app);
        return;
      case 's.open':
        return void this.openStream(client, msg.sid, msg.op, msg.meta);
      case 's.data': {
        const s = this.streams.get(msg.sid);
        if (!s || msg.data.byteLength > FRAME_LIMITS.MAX_CHUNK_BYTES) return;
        // Ack once the chunk is handed to the data channel (write() waits on its backpressure).
        s.write(new Uint8Array(msg.data)).then(
          () => this.post({ t: 's.ack', sid: msg.sid }),
          (err) => { this.streams.delete(msg.sid); this.post({ t: 's.abort', sid: msg.sid, reason: portError(err).message }); },
        );
        return;
      }
      case 's.end':
        this.streams.get(msg.sid)?.end();
        return;
      case 's.abort': {
        const s = this.streams.get(msg.sid);
        this.streams.delete(msg.sid);
        s?.abort(msg.reason);
        return;
      }
    }
  }

  private async openStream(client: WireClient | undefined, sid: number, op: string, meta: unknown): Promise<void> {
    if (!client) return this.post({ t: 's.reject', sid, error: { code: 'DISCONNECTED', message: 'not connected to the Pi' } });
    if (this.streams.has(sid)) return this.post({ t: 's.reject', sid, error: { code: 'BAD_REQUEST', message: 'stream id in use' } });
    try {
      const s = await client.openStream(this.o.app, op, meta);
      this.streams.set(sid, s);
      s.onData((chunk) => {
        const copy = chunk.slice().buffer as ArrayBuffer;
        this.post({ t: 's.data', sid, data: copy }, [copy]); // transferred, not copied
      });
      s.onEnd(() => this.post({ t: 's.end', sid }));
      s.onAbort((reason) => { this.streams.delete(sid); this.post({ t: 's.abort', sid, reason }); });
      this.post({ t: 's.ok', sid });
    } catch (err) {
      this.post({ t: 's.reject', sid, error: portError(err) });
    }
  }
}
