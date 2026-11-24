/**
 * The phone end of the data channel (Phase 3 §6): requests, events, streams,
 * heartbeat. One WireClient per open session.
 */
import { decodeChunk, encodeChunk, parseWireFrame, WIRE, type WireError, type WireFrame } from '@pifi/protocol/browser';
import { ShellError } from './errors.js';

export class RequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface ShellStream {
  readonly sid: number;
  /** Resolves when it is OK to send more (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  abort(reason: string): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onEnd(cb: () => void): void;
  onAbort(cb: (reason: string) => void): void;
}

interface StreamEntry {
  data: (c: Uint8Array) => void;
  end: () => void;
  abort: (r: string) => void;
  opened?: { resolve: () => void; reject: (e: Error) => void };
  /** Data that arrived before handlers were attached. */
  early: Uint8Array[];
}

export class WireClient {
  private nextId = 1;
  private nextSid = 1; // odd: opened by the phone
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly streams = new Map<number, StreamEntry>();
  private readonly subs = new Map<string, number>();
  private readonly eventCbs = new Set<(app: string, name: string, data: unknown) => void>();
  private readonly closeCbs = new Set<(reason: string) => void>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private pingN = 0;
  private missed = 0;
  private closed = false;

  constructor(private readonly channel: RTCDataChannel, private readonly opts: { pingMs?: number; maxMissed?: number } = {}) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = WIRE.BUFFER_LOW;
    channel.addEventListener('message', (ev) => this.onMessage(ev.data as string | ArrayBuffer));
    channel.addEventListener('close', () => this.shutdown('channel closed'));
    this.pingTimer = setInterval(() => this.ping(), opts.pingMs ?? WIRE.PING_INTERVAL_MS);
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }

  onEvent(cb: (app: string, name: string, data: unknown) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCbs.add(cb);
  }

  /** Control op (no app) or app request. Rejects with RequestError(code) on an error response. */
  request(op: string, payload?: unknown, opts: { app?: string; timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.isOpen) return Promise.reject(new ShellError('DISCONNECTED'));
    if (this.pending.size >= WIRE.MAX_INFLIGHT) return Promise.reject(new RequestError('BUSY', 'too many requests in flight'));
    const id = (this.nextId++).toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestError('TIMEOUT', 'no response in time'));
      }, opts.timeoutMs ?? WIRE.APP_REQUEST_TIMEOUT_MS + 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame({ t: 'req', id, op, ...(opts.app ? { app: opts.app } : {}), ...(payload !== undefined ? { payload } : {}) });
    });
  }

  /** Reference-counted, so several frames of the same app share one subscription. */
  subscribe(app: string): void {
    const n = (this.subs.get(app) ?? 0) + 1;
    this.subs.set(app, n);
    if (n === 1) this.sendFrame({ t: 'sub', app });
  }

  unsubscribe(app: string): void {
    const n = (this.subs.get(app) ?? 0) - 1;
    if (n > 0) return void this.subs.set(app, n);
    this.subs.delete(app);
    this.sendFrame({ t: 'unsub', app });
  }

  async openStream(app: string, op: string, meta?: unknown): Promise<ShellStream> {
    if (!this.isOpen) throw new ShellError('DISCONNECTED');
    if (this.streams.size >= WIRE.MAX_STREAMS) throw new RequestError('BUSY', 'too many streams');
    const sid = this.nextSid;
    this.nextSid += 2;
    // Until the caller attaches handlers, keep what arrives instead of dropping it.
    let dataCb: ((c: Uint8Array) => void) | undefined;
    let endCb: (() => void) | undefined;
    let abortCb: ((r: string) => void) | undefined;
    let remoteEnded = false;
    let abortReason: string | undefined;
    const entry: StreamEntry = {
      data: (c) => (dataCb ? dataCb(c) : entry.early.push(c)),
      end: () => { remoteEnded = true; endCb?.(); },
      abort: (r) => { abortReason = r; abortCb?.(r); },
      early: [],
    };
    this.streams.set(sid, entry);
    await new Promise<void>((resolve, reject) => {
      entry.opened = { resolve, reject };
      this.sendFrame({ t: 's.open', sid, app, op, ...(meta !== undefined ? { meta } : {}) });
    });
    let ended = false;
    return {
      sid,
      write: async (chunk) => {
        if (ended) throw new Error('stream ended');
        for (let o = 0; o < chunk.length; o += WIRE.MAX_CHUNK_BYTES) {
          if (!this.isOpen) throw new ShellError('DISCONNECTED');
          if (!this.streams.has(sid)) throw new RequestError('ABORTED', 'stream aborted');
          // Backpressure: wait for the channel to drain below the high-water mark.
          while (this.channel.bufferedAmount > WIRE.BUFFER_HIGH) {
            await new Promise<void>((r) => this.channel.addEventListener('bufferedamountlow', () => r(), { once: true }));
          }
          this.channel.send(encodeChunk(sid, chunk.subarray(o, o + WIRE.MAX_CHUNK_BYTES)).slice().buffer as ArrayBuffer);
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.sendFrame({ t: 's.end', sid });
      },
      abort: (reason) => {
        this.streams.delete(sid);
        this.sendFrame({ t: 's.abort', sid, reason: reason.slice(0, 200) });
      },
      onData: (cb) => { dataCb = cb; for (const c of entry.early.splice(0)) cb(c); },
      onEnd: (cb) => { endCb = cb; if (remoteEnded) cb(); },
      onAbort: (cb) => { abortCb = cb; if (abortReason !== undefined) cb(abortReason); },
    };
  }

  close(): void {
    try { this.channel.close(); } catch { /* already closed */ }
    this.shutdown('closed by phone');
  }

  // -------------------------------------------------------------------------

  private sendFrame(frame: WireFrame): void {
    if (!this.isOpen) return;
    this.channel.send(JSON.stringify(frame));
  }

  private ping(): void {
    if (!this.isOpen) return;
    if (this.missed >= (this.opts.maxMissed ?? 2)) {
      // Two pongs missed: the connection is dead even if the browser hasn't noticed.
      this.close();
      return;
    }
    this.missed++;
    this.sendFrame({ t: 'ping', n: ++this.pingN });
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      const chunk = decodeChunk(new Uint8Array(data));
      const st = chunk && this.streams.get(chunk.sid);
      if (!st || !chunk) return;
      const copy = new Uint8Array(chunk.data);
      st.data(copy);
      return;
    }
    const f = parseWireFrame(data);
    if (!f) return;
    switch (f.t) {
      case 'pong':
        this.missed = 0;
        return;
      case 'ping':
        return this.sendFrame({ t: 'pong', n: f.n });
      case 'res': {
        const p = this.pending.get(f.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(f.id);
        if (f.ok) p.resolve(f.payload);
        else p.reject(new RequestError(f.error.code, f.error.message));
        return;
      }
      case 'evt':
        for (const cb of this.eventCbs) cb(f.app, f.name, f.data);
        return;
      case 's.ok':
        this.streams.get(f.sid)?.opened?.resolve();
        return;
      case 's.reject': {
        const st = this.streams.get(f.sid);
        this.streams.delete(f.sid);
        st?.opened?.reject(new RequestError(f.error.code, f.error.message));
        return;
      }
      case 's.end':
        this.streams.get(f.sid)?.end();
        return;
      case 's.abort': {
        const st = this.streams.get(f.sid);
        this.streams.delete(f.sid);
        if (st?.opened) st.opened.reject(new RequestError('ABORTED', f.reason));
        st?.abort(f.reason);
        return;
      }
      case 's.open':
        // Pi-opened streams have no consumer in the Phase 3 shell.
        return this.sendFrame({ t: 's.reject', sid: f.sid, error: { code: 'NO_HANDLER', message: 'not supported by this shell' } satisfies WireError });
      default:
        return;
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new ShellError('DISCONNECTED')); }
    this.pending.clear();
    for (const [, st] of this.streams) { st.opened?.reject(new ShellError('DISCONNECTED')); st.abort('disconnected'); }
    this.streams.clear();
    for (const cb of this.closeCbs) cb(reason);
  }
}
