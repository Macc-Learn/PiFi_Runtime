/**
 * Byte streams between PiFi and one app process (Phase 3 §8.3).
 *
 * On the localhost app socket a stream is: a `stream.open {sid, op, meta}`
 * control message, answered by `stream.accept` / `stream.reject`, then binary
 * frames `[u32 sid][bytes]` in both directions. `stream.end` is a HALF-close
 * ("I'm done sending"); the stream is gone once both sides sent it, or as soon
 * as either side sends `stream.abort`. PiFi-opened streams use odd sids,
 * app-opened streams even sids, so the two sides never pick the same number.
 *
 * The "other end" of every stream is an Endpoint: in practice a phone session
 * that forwards the bytes over the WebRTC data channel.
 */
import { decodeChunk, encodeChunk, PROTOCOL_VERSION, WIRE, type StreamMessage } from '@pifi/protocol';
import { PifiError } from './errors.js';
import type { Logger } from './logger.js';

/** Where an app stream's bytes go (usually a phone session). */
export interface StreamEndpoint {
  onData(data: Uint8Array): void;
  onEnd(): void;
  onAbort(reason: string): void;
}

/** The PiFi side of an open app stream. */
export interface AppStreamHandle {
  readonly sid: number;
  /** Send bytes to the app. Returns false (and aborts) if the app has stopped reading. */
  write(data: Uint8Array): boolean;
  end(): void;
  abort(reason: string): void;
}

/** An app asked to open a stream towards a phone session. */
export interface AppOpenRequest {
  session: string;
  op: string;
  meta: unknown;
  accept(endpoint: StreamEndpoint): AppStreamHandle;
  reject(code: string, message: string): void;
}

interface Entry {
  endpoint?: StreamEndpoint;
  idle?: NodeJS.Timeout;
  /** PiFi sent stream.end (no more bytes towards the app). */
  sentEnd?: boolean;
  /** The app sent stream.end (no more bytes from the app). */
  gotEnd?: boolean;
  opening?: { resolve: (h: AppStreamHandle) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
}

export interface AppStreamOptions {
  maxStreams: number;
  idleMs: number;
  openTimeoutMs: number;
  /** If this much is queued towards the app, it isn't reading: abort rather than buffer forever. */
  maxAppBacklog: number;
}

export const DEFAULT_APP_STREAM_OPTIONS: AppStreamOptions = {
  maxStreams: 8,
  idleMs: 30_000,
  openTimeoutMs: 10_000,
  maxAppBacklog: 4 * 1024 * 1024,
};

export class AppStreams {
  private readonly streams = new Map<number, Entry>();
  private nextSid = 1; // odd: opened by PiFi

  constructor(
    private readonly app: string,
    private readonly io: {
      send(msg: StreamMessage): void;
      sendBinary(frame: Uint8Array): void;
      bufferedAmount(): number;
    },
    private readonly opts: AppStreamOptions,
    private readonly log: Logger,
    /** Called when the app opens a stream itself. */
    private readonly onAppOpen?: (req: AppOpenRequest) => void,
  ) {}

  get size(): number {
    return this.streams.size;
  }

  /** PiFi -> app: open a stream for `op`. Resolves once the app accepts. */
  open(op: string, meta: unknown, endpoint: StreamEndpoint): Promise<AppStreamHandle> {
    if (this.streams.size >= this.opts.maxStreams) {
      return Promise.reject(new PifiError('BUSY', `${this.app} already has ${this.opts.maxStreams} open streams`, 429));
    }
    const sid = this.nextSid;
    this.nextSid = this.nextSid >= 0xfffffffd ? 1 : this.nextSid + 2;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(sid);
        this.io.send({ v: PROTOCOL_VERSION, type: 'stream.abort', sid, reason: 'open timeout' });
        reject(new PifiError('REQUEST_TIMEOUT', 'app did not accept the stream in time', 504));
      }, this.opts.openTimeoutMs);
      this.streams.set(sid, { endpoint, opening: { resolve, reject, timer } });
      this.io.send({ v: PROTOCOL_VERSION, type: 'stream.open', sid, op, meta });
    });
  }

  /** A stream.* message from the app. */
  onMessage(msg: StreamMessage): void {
    const entry = this.streams.get(msg.sid);
    switch (msg.type) {
      case 'stream.accept': {
        if (!entry?.opening) return;
        clearTimeout(entry.opening.timer);
        const { resolve } = entry.opening;
        entry.opening = undefined;
        this.touch(msg.sid);
        resolve(this.handle(msg.sid));
        return;
      }
      case 'stream.reject': {
        if (!entry?.opening) return;
        clearTimeout(entry.opening.timer);
        this.streams.delete(msg.sid);
        entry.opening.reject(new PifiError('APP_ERROR', `${msg.error.code}: ${msg.error.message}`, 502));
        return;
      }
      case 'stream.end':
        if (!entry || entry.opening || entry.gotEnd) return;
        entry.gotEnd = true;
        entry.endpoint?.onEnd();
        if (entry.sentEnd) this.finish(msg.sid);
        return;
      case 'stream.abort':
        if (!entry) return;
        this.finish(msg.sid);
        if (entry.opening) entry.opening.reject(new PifiError('APP_ERROR', `stream aborted: ${msg.reason}`, 502));
        else entry.endpoint?.onAbort(msg.reason);
        return;
      case 'stream.open':
        this.onAppOpened(msg.sid, msg.op, msg.meta, msg.session);
        return;
    }
  }

  /** A binary frame from the app. Returns false if it is malformed or for no open stream. */
  onBinary(frame: Uint8Array): boolean {
    const chunk = decodeChunk(frame);
    if (!chunk) return false;
    const entry = this.streams.get(chunk.sid);
    if (!entry?.endpoint || entry.opening || entry.gotEnd) return false;
    this.touch(chunk.sid);
    entry.endpoint.onData(chunk.data);
    return true;
  }

  /** App went away: every stream is aborted. */
  closeAll(reason: string): void {
    for (const [sid, entry] of this.streams) {
      this.finish(sid);
      if (entry.opening) {
        clearTimeout(entry.opening.timer);
        entry.opening.reject(new PifiError('APP_EXITED', reason, 502));
      } else {
        entry.endpoint?.onAbort(reason);
      }
    }
  }

  // -------------------------------------------------------------------------

  private onAppOpened(sid: number, op: string, meta: unknown, session: string | undefined): void {
    const reject = (code: string, message: string): void =>
      this.io.send({ v: PROTOCOL_VERSION, type: 'stream.reject', sid, error: { code, message } });
    if (sid % 2 !== 0) return reject('BAD_REQUEST', 'app-opened streams must use even ids');
    if (this.streams.has(sid)) return reject('BAD_REQUEST', 'stream id in use');
    if (this.streams.size >= this.opts.maxStreams) return reject('BUSY', 'too many open streams');
    if (!session || !this.onAppOpen) return reject('BAD_REQUEST', 'stream.open needs a `session` from a request');
    this.streams.set(sid, {}); // reserve the id while the phone decides
    let settled = false;
    this.onAppOpen({
      session,
      op,
      meta,
      accept: (endpoint) => {
        if (settled) throw new Error('already settled');
        settled = true;
        const entry = this.streams.get(sid);
        if (!entry) throw new PifiError('APP_EXITED', 'app went away', 502);
        entry.endpoint = endpoint;
        this.touch(sid);
        this.io.send({ v: PROTOCOL_VERSION, type: 'stream.accept', sid });
        return this.handle(sid);
      },
      reject: (code, message) => {
        if (settled) return;
        settled = true;
        this.streams.delete(sid);
        reject(code, message);
      },
    });
  }

  private handle(sid: number): AppStreamHandle {
    return {
      sid,
      write: (data) => {
        const entry = this.streams.get(sid);
        if (!entry || entry.sentEnd) return false;
        if (this.io.bufferedAmount() > this.opts.maxAppBacklog) {
          this.log.warn(`app "${this.app}" is not reading stream data; aborting stream`);
          this.abortFromPifi(sid, 'app not reading');
          return false;
        }
        // Split anything larger than one frame (the phone side already chunks to 16 KiB).
        for (let o = 0; o < data.length; o += WIRE.MAX_CHUNK_BYTES) {
          this.io.sendBinary(encodeChunk(sid, data.subarray(o, o + WIRE.MAX_CHUNK_BYTES)));
        }
        this.touch(sid);
        return true;
      },
      end: () => {
        const entry = this.streams.get(sid);
        if (!entry || entry.sentEnd) return;
        entry.sentEnd = true;
        this.io.send({ v: PROTOCOL_VERSION, type: 'stream.end', sid });
        if (entry.gotEnd) this.finish(sid);
      },
      abort: (reason) => this.abortFromPifi(sid, reason),
    };
  }

  private abortFromPifi(sid: number, reason: string): void {
    const entry = this.streams.get(sid);
    if (!entry) return;
    this.finish(sid);
    this.io.send({ v: PROTOCOL_VERSION, type: 'stream.abort', sid, reason: reason.slice(0, 200) });
    entry.endpoint?.onAbort(reason);
  }

  /** Any traffic resets the idle timer; a stuck stream can't hold resources for long. */
  private touch(sid: number): void {
    const entry = this.streams.get(sid);
    if (!entry) return;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => this.abortFromPifi(sid, 'idle timeout'), this.opts.idleMs);
  }

  private finish(sid: number): void {
    const entry = this.streams.get(sid);
    if (entry?.idle) clearTimeout(entry.idle);
    this.streams.delete(sid);
  }
}
