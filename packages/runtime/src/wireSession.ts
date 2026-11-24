/**
 * One authenticated phone session: routes data-channel frames (Phase 3 §6, §7).
 *
 *   req without `app`  -> control op (status, apps.*, phones.*), handled here
 *   req with `app`     -> that app's process, as a Phase 1 `request {op, payload}`
 *   sub / unsub        -> which apps' events this phone wants
 *   s.open ...         -> byte streams, bridged to the app's localhost socket
 *   ping               -> pong
 *
 * The channel was authenticated by the session handshake (sessions.ts), so
 * there is no login message. Anything malformed closes the session.
 */
import { randomBytes } from 'node:crypto';
import { decodeChunk, encodeChunk, parseWireFrame, WIRE, type WireError, type WireFrame } from '@pifi/protocol';
import type { AppManager } from './appManager.js';
import type { AppOpenRequest, AppStreamHandle } from './appStreams.js';
import { PifiError } from './errors.js';
import type { Logger } from './logger.js';
import type { PiChannel } from './peer.js';

/** What a session needs from the rest of the daemon. */
export interface SessionContext {
  manager: AppManager;
  log: Logger;
  idleMs: number;
  /** Text frames per second (sustained) and burst, before the session is closed. */
  textRate: { burst: number; perSec: number };
  appRequestTimeoutMs: number;
  status(): Promise<Record<string, unknown>>;
  listPhones(currentPhoneId: string): Array<Record<string, unknown>>;
  /** Revoke a paired phone (closes its session). Returns false if unknown. */
  revokePhone(phoneId: string): boolean;
}

interface StreamState {
  app: string;
  handle?: AppStreamHandle;
  /** Half-close bookkeeping: the stream is gone once both sides sent s.end. */
  phoneEnded?: boolean;
  appEnded?: boolean;
  /** For streams the Pi opened (even sid): waiting for the phone's s.ok / s.reject. */
  pending?: { req: AppOpenRequest; timer: NodeJS.Timeout };
}

const CONTROL_OPS = new Set(['status', 'apps.list', 'apps.start', 'apps.stop', 'apps.restart', 'phones.list', 'phones.revoke']);

function wireError(err: unknown): WireError {
  if (err instanceof PifiError) {
    const map: Partial<Record<PifiError['code'], string>> = {
      NOT_FOUND: 'NOT_FOUND', NOT_RUNNING: 'APP_NOT_RUNNING', REQUEST_TIMEOUT: 'TIMEOUT', BAD_REQUEST: 'BAD_REQUEST',
      BUSY: 'BUSY', APP_EXITED: 'APP_NOT_RUNNING', HASH_MISMATCH: 'START_FAILED', INSUFFICIENT_MEMORY: 'START_FAILED',
      START_TIMEOUT: 'START_FAILED', EXITED: 'START_FAILED', SPAWN_FAILED: 'START_FAILED',
    };
    const code = err.code === 'APP_ERROR' ? (err.appCode ?? 'APP_ERROR') : (map[err.code] ?? 'INTERNAL');
    return { code: code.slice(0, 64), message: err.message.slice(0, 1000) };
  }
  return { code: 'INTERNAL', message: 'internal error' };
}

const badRequest = (message: string): PifiError => new PifiError('BAD_REQUEST', message, 400);

export class WireSession {
  /** Opaque id given to apps in requests (lets them open a stream back to this phone). */
  readonly id = randomBytes(16).toString('hex');
  private channel?: PiChannel;
  private readonly subs = new Set<string>();
  private readonly streams = new Map<number, StreamState>();
  private inflight = 0;
  private nextPiSid = 2; // even: opened by the Pi
  private idleTimer?: NodeJS.Timeout;
  private tokens: number;
  private lastRefill = Date.now();
  /** Apps whose sockets we paused because the phone is slow. */
  private pausedApps = new Set<string>();
  private closed = false;
  private closeCbs: Array<() => void> = [];

  constructor(readonly phoneId: string, private readonly ctx: SessionContext) {
    this.tokens = ctx.textRate.burst;
  }

  get isOpen(): boolean {
    return !!this.channel && !this.closed;
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  attach(channel: PiChannel): void {
    this.channel = channel;
    channel.setBufferedLowThreshold(WIRE.BUFFER_LOW);
    channel.onText((t) => this.onText(t));
    channel.onBinary((b) => this.onBinary(b));
    channel.onBufferedLow(() => this.resumeApps());
    channel.onClose(() => this.close('channel closed'));
    this.touch();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [, st] of this.streams) {
      st.handle?.abort(`phone session ended (${reason})`);
      if (st.pending) { clearTimeout(st.pending.timer); st.pending.req.reject('DISCONNECTED', 'phone went away'); }
    }
    this.streams.clear();
    this.resumeApps();
    this.channel?.close();
    this.ctx.log.info(`session for phone ${this.phoneId.slice(0, 8)}… closed (${reason})`);
    for (const cb of this.closeCbs) cb();
  }

  /** Forward an app event if this phone subscribed to that app. Oversized events are dropped. */
  deliverEvent(app: string, name: string, data: unknown): void {
    if (!this.subs.has(app)) return;
    this.send({ t: 'evt', app, name, data }, true);
  }

  // -------------------------------------------------------------------------

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle'), this.ctx.idleMs);
  }

  /** Returns false if the frame was too big to send. */
  private send(frame: WireFrame, dropIfTooBig = false): boolean {
    if (!this.isOpen) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > WIRE.MAX_TEXT_BYTES) {
      if (dropIfTooBig) return false;
      if (frame.t === 'res') {
        this.channel?.sendText(JSON.stringify({ t: 'res', id: frame.id, ok: false, error: { code: 'TOO_LARGE', message: 'response over 64 KiB' } }));
      }
      return false;
    }
    this.channel?.sendText(text);
    return true;
  }

  private takeToken(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.ctx.textRate.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ctx.textRate.perSec);
    this.lastRefill = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }

  private onText(text: string): void {
    if (this.closed) return;
    this.touch();
    if (!this.takeToken()) return this.close('rate limit');
    const frame = parseWireFrame(text);
    if (!frame) return this.close('malformed frame');
    switch (frame.t) {
      case 'ping':
        this.send({ t: 'pong', n: frame.n });
        return;
      case 'pong':
        return;
      case 'req':
        return void this.onRequest(frame.id, frame.app, frame.op, frame.payload);
      case 'sub':
        if (this.ctx.manager.records.has(frame.app)) this.subs.add(frame.app);
        return;
      case 'unsub':
        this.subs.delete(frame.app);
        return;
      case 's.open':
        return void this.onPhoneStreamOpen(frame.sid, frame.app, frame.op, frame.meta);
      case 's.ok':
      case 's.reject':
        return this.onPhoneStreamAnswer(frame.sid, frame.t === 's.ok' ? undefined : frame.error);
      case 's.end': {
        const st = this.streams.get(frame.sid);
        if (!st?.handle || st.phoneEnded) return;
        st.phoneEnded = true;
        st.handle.end(); // half-close: the app may still send
        if (st.appEnded) this.streams.delete(frame.sid);
        return;
      }
      case 's.abort': {
        const st = this.streams.get(frame.sid);
        if (!st) return;
        this.streams.delete(frame.sid);
        st.handle?.abort(frame.reason);
        return;
      }
      default:
        // res / evt are Pi -> phone only.
        return this.close('unexpected frame');
    }
  }

  private onBinary(frame: Uint8Array): void {
    if (this.closed) return;
    this.touch();
    const chunk = decodeChunk(frame);
    if (!chunk) return this.close('malformed binary frame');
    const st = this.streams.get(chunk.sid);
    if (!st?.handle || st.phoneEnded) return; // late data for a finished stream: ignore
    if (!st.handle.write(chunk.data)) this.streams.delete(chunk.sid); // app stopped reading -> aborted
  }

  // ---- requests ----

  private async onRequest(id: string, app: string | undefined, op: string, payload: unknown): Promise<void> {
    if (this.inflight >= WIRE.MAX_INFLIGHT) {
      this.send({ t: 'res', id, ok: false, error: { code: 'BUSY', message: `more than ${WIRE.MAX_INFLIGHT} requests in flight` } });
      return;
    }
    this.inflight++;
    try {
      const result = app === undefined
        ? await this.controlOp(op, payload)
        : await this.ctx.manager.request(app, { op, payload }, this.ctx.appRequestTimeoutMs, this.id);
      this.send({ t: 'res', id, ok: true, payload: result });
    } catch (err) {
      this.send({ t: 'res', id, ok: false, error: wireError(err) });
    } finally {
      this.inflight--;
    }
  }

  private async controlOp(op: string, payload: unknown): Promise<unknown> {
    if (!CONTROL_OPS.has(op)) throw new PifiError('NOT_FOUND', `unknown op "${op}"`, 404);
    const m = this.ctx.manager;
    const appName = (): string => {
      const name = (payload as { name?: unknown } | undefined)?.name;
      if (typeof name !== 'string') throw badRequest('payload.name is required');
      return name;
    };
    switch (op) {
      case 'status':
        return this.ctx.status();
      case 'apps.list':
        return m.list().map((a) => ({
          name: a.name, version: a.version, description: a.description, displayName: a.displayName, state: a.state, frontend: a.frontend,
        }));
      case 'apps.start':
        return { state: (await m.start(appName())).state };
      case 'apps.stop':
        return { state: (await m.stop(appName())).state };
      case 'apps.restart':
        return { state: (await m.restart(appName())).state };
      case 'phones.list':
        return this.ctx.listPhones(this.phoneId);
      case 'phones.revoke': {
        const phoneId = (payload as { phoneId?: unknown } | undefined)?.phoneId;
        if (typeof phoneId !== 'string') throw badRequest('payload.phoneId is required');
        if (phoneId === this.phoneId) {
          // Revoking yourself is allowed: reply first, then go.
          setImmediate(() => this.ctx.revokePhone(phoneId));
          return {};
        }
        if (!this.ctx.revokePhone(phoneId)) throw new PifiError('NOT_FOUND', 'no such phone', 404);
        return {};
      }
    }
    throw new PifiError('NOT_FOUND', `unknown op "${op}"`, 404);
  }

  // ---- streams ----

  private async onPhoneStreamOpen(sid: number, app: string, op: string, meta: unknown): Promise<void> {
    const reject = (error: WireError): void => void this.send({ t: 's.reject', sid, error });
    if (sid % 2 !== 1) return reject({ code: 'BAD_REQUEST', message: 'phone-opened streams use odd ids' });
    if (this.streams.has(sid)) return reject({ code: 'BAD_REQUEST', message: 'stream id in use' });
    if (this.streams.size >= WIRE.MAX_STREAMS) return reject({ code: 'BUSY', message: `at most ${WIRE.MAX_STREAMS} streams` });
    const st: StreamState = { app };
    this.streams.set(sid, st); // reserve the id
    try {
      st.handle = await this.ctx.manager.openStream(app, op, meta, this.endpointFor(sid, app));
      if (this.closed) return st.handle.abort('session closed');
      this.send({ t: 's.ok', sid });
    } catch (err) {
      this.streams.delete(sid);
      reject(wireError(err));
    }
  }

  /** The app opened a stream towards this phone (even sid). */
  openFromApp(app: string, req: AppOpenRequest): void {
    if (this.closed) return req.reject('DISCONNECTED', 'phone went away');
    if (this.streams.size >= WIRE.MAX_STREAMS) return req.reject('BUSY', 'too many streams');
    const sid = this.nextPiSid;
    this.nextPiSid = this.nextPiSid >= 0xfffffffe ? 2 : this.nextPiSid + 2;
    const timer = setTimeout(() => {
      this.streams.delete(sid);
      req.reject('TIMEOUT', 'phone did not accept the stream');
    }, 10_000);
    this.streams.set(sid, { app, pending: { req, timer } });
    this.send({ t: 's.open', sid, app, op: req.op, meta: req.meta });
  }

  private onPhoneStreamAnswer(sid: number, error: WireError | undefined): void {
    const st = this.streams.get(sid);
    if (!st?.pending) return;
    clearTimeout(st.pending.timer);
    const { req } = st.pending;
    st.pending = undefined;
    if (error) {
      this.streams.delete(sid);
      return req.reject(error.code, error.message);
    }
    st.handle = req.accept(this.endpointFor(sid, st.app));
  }

  /** Bytes from the app go to the phone, with backpressure on the data channel. */
  private endpointFor(sid: number, app: string): Parameters<AppManager['openStream']>[3] {
    return {
      onData: (data) => {
        if (!this.isOpen) return;
        this.channel?.sendBinary(encodeChunk(sid, data));
        if ((this.channel?.bufferedAmount() ?? 0) > WIRE.BUFFER_HIGH && !this.pausedApps.has(app)) {
          // The phone is slower than the app: stop reading the app's socket until the channel drains.
          this.pausedApps.add(app);
          this.ctx.manager.setPaused(app, this.id, true);
        }
      },
      onEnd: () => {
        const st = this.streams.get(sid);
        if (!st || st.appEnded) return;
        st.appEnded = true;
        this.send({ t: 's.end', sid });
        if (st.phoneEnded) this.streams.delete(sid); // both sides done
      },
      onAbort: (reason) => {
        if (!this.streams.has(sid)) return;
        this.streams.delete(sid);
        this.send({ t: 's.abort', sid, reason: reason.slice(0, 200) });
      },
    };
  }

  private resumeApps(): void {
    for (const app of this.pausedApps) this.ctx.manager.setPaused(app, this.id, false);
    this.pausedApps.clear();
  }
}
