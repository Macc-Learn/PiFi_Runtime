/**
 * @pifi/sdk — a tiny helper so app authors don't hand-write the PiFi protocol.
 *
 *   const app = createApp();
 *   app.onRequest(async ({ op, payload }) => ({ echoed: payload }));
 *   app.onStream('upload', async (stream, meta) => {
 *     for await (const chunk of stream) { ... }   // bytes from the phone
 *     await stream.write(bytes);                   // bytes to the phone
 *     stream.end();
 *   });
 *   app.emit('progress', { done: 3 });             // to every subscribed phone
 *   await app.start();                             // connect -> hello -> welcome -> ready
 *
 * The real contract is the JSON protocol in @pifi/protocol (documented in
 * docs/ARCHITECTURE.md); this file is one convenient implementation of it.
 */
import WebSocket from 'ws';
import { encode, parsePiMessage, PROTOCOL_VERSION, STREAMS_CAPABILITY, decodeChunk, encodeChunk, WIRE } from '@pifi/protocol';

export const SDK_VERSION = '0.2.0';

export interface RequestContext {
  /** Opaque id of the phone session that sent the request; pass it to openStream() to stream back. */
  session?: string;
}

export type RequestHandler = (payload: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
export type ShutdownHandler = (info: { graceMs: number; reason: string }) => void | Promise<void>;
export type StreamHandler = (stream: PifiStream, meta: unknown) => void | Promise<void>;

/**
 * A two-way byte stream. Iterate it to read; `write()` to send (it waits when the
 * socket is backed up, which is how backpressure reaches your code); `end()`
 * when you are done sending. A stream is finished once both sides ended.
 */
export interface PifiStream extends AsyncIterable<Uint8Array> {
  readonly sid: number;
  readonly op: string;
  write(chunk: Uint8Array): Promise<void>;
  end(): void;
  abort(reason?: string): void;
}

export interface CreateAppOptions {
  url?: string;
  name?: string;
  token?: string;
  connectTimeoutMs?: number;
}

export interface PifiApp {
  /** The function that answers requests. Its return value becomes the response payload; a throw becomes an error. */
  onRequest(handler: RequestHandler): void;
  /** Handle streams the phone opens for `op`. */
  onStream(op: string, handler: StreamHandler): void;
  /** Open a stream towards the phone session that sent a request (ctx.session). */
  openStream(session: string, op: string, meta?: unknown): Promise<PifiStream>;
  /** Cleanup to run when PiFi asks us to shut down. After it finishes we exit with code 0. */
  onShutdown(handler: ShutdownHandler): void;
  /** Send an event to every phone subscribed to this app. */
  emit(name: string, data?: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  start(): Promise<void>;
}

/** Above this many queued bytes, write() waits (same number the data channel uses). */
const HIGH_WATER = WIRE.BUFFER_HIGH;

class StreamImpl implements PifiStream {
  private queue: Uint8Array[] = [];
  private waiting?: { resolve: (r: IteratorResult<Uint8Array>) => void; reject: (e: Error) => void };
  private remoteEnded = false;
  private localEnded = false;
  private error?: Error;

  constructor(
    readonly sid: number,
    readonly op: string,
    private readonly socket: () => WebSocket | undefined,
    private readonly sendCtl: (msg: Parameters<typeof encode>[0]) => void,
    private readonly forget: (sid: number) => void,
  ) {}

  // ---- incoming (called by the app) ----
  push(data: Uint8Array): void {
    if (this.remoteEnded || this.error) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve({ value: data, done: false });
    } else {
      this.queue.push(data);
    }
  }

  remoteEnd(): void {
    this.remoteEnded = true;
    this.waiting?.resolve({ value: undefined, done: true });
    this.waiting = undefined;
    if (this.localEnded) this.forget(this.sid);
  }

  remoteAbort(reason: string): void {
    this.error = new Error(`stream aborted: ${reason}`);
    this.waiting?.reject(this.error);
    this.waiting = undefined;
    this.forget(this.sid);
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.remoteEnded) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
      },
    };
  }

  // ---- outgoing ----
  async write(chunk: Uint8Array): Promise<void> {
    for (let o = 0; o < chunk.length; o += WIRE.MAX_CHUNK_BYTES) {
      if (this.error) throw this.error;
      if (this.localEnded) throw new Error('stream already ended');
      const ws = this.socket();
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('not connected to PiFi');
      // Backpressure: wait for the socket to drain instead of buffering without limit.
      while (ws.bufferedAmount > HIGH_WATER) await new Promise((r) => setTimeout(r, 5));
      ws.send(encodeChunk(this.sid, chunk.subarray(o, o + WIRE.MAX_CHUNK_BYTES)));
    }
  }

  end(): void {
    if (this.localEnded || this.error) return;
    this.localEnded = true;
    this.sendCtl({ v: PROTOCOL_VERSION, type: 'stream.end', sid: this.sid });
    if (this.remoteEnded) this.forget(this.sid);
  }

  abort(reason = 'aborted by app'): void {
    if (this.error) return;
    this.error = new Error(reason);
    this.sendCtl({ v: PROTOCOL_VERSION, type: 'stream.abort', sid: this.sid, reason: reason.slice(0, 200) });
    this.waiting?.reject(this.error);
    this.forget(this.sid);
  }
}

export function createApp(options: CreateAppOptions = {}): PifiApp {
  const url = options.url ?? process.env.PIFI_URL;
  const name = options.name ?? process.env.PIFI_APP_NAME;
  const token = options.token ?? process.env.PIFI_APP_TOKEN;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;

  if (!url || !name || !token) {
    throw new Error('PIFI_URL, PIFI_APP_NAME and PIFI_APP_TOKEN must be set (are you running under PiFi?)');
  }

  let requestHandler: RequestHandler | undefined;
  let shutdownHandler: ShutdownHandler | undefined;
  const streamHandlers = new Map<string, StreamHandler>();
  const streams = new Map<number, StreamImpl>();
  const opening = new Map<number, { resolve: (s: PifiStream) => void; reject: (e: Error) => void }>();
  let nextSid = 2; // even: opened by the app
  let socket: WebSocket | undefined;

  function send(message: Parameters<typeof encode>[0]): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(message));
  }

  const newStream = (sid: number, op: string): StreamImpl =>
    new StreamImpl(sid, op, () => socket, send, (id) => streams.delete(id));

  async function handleRequest(id: string, payload: unknown, session: string | undefined): Promise<void> {
    if (!requestHandler) {
      send({ v: PROTOCOL_VERSION, type: 'response', id, error: { code: 'NO_HANDLER', message: 'app has no request handler' } });
      return;
    }
    try {
      const result = await requestHandler(payload, { session });
      send({ v: PROTOCOL_VERSION, type: 'response', id, payload: result });
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      const code = typeof e?.code === 'string' ? e.code : 'HANDLER_ERROR';
      send({ v: PROTOCOL_VERSION, type: 'response', id, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  function handleStreamOpen(sid: number, op: string, meta: unknown): void {
    const handler = streamHandlers.get(op);
    if (!handler) {
      send({ v: PROTOCOL_VERSION, type: 'stream.reject', sid, error: { code: 'NO_HANDLER', message: `no stream handler for "${op}"` } });
      return;
    }
    const stream = newStream(sid, op);
    streams.set(sid, stream);
    send({ v: PROTOCOL_VERSION, type: 'stream.accept', sid });
    Promise.resolve()
      .then(() => handler(stream, meta))
      .catch((err) => stream.abort(err instanceof Error ? err.message : String(err)));
  }

  async function handleShutdown(info: { graceMs: number; reason: string }): Promise<void> {
    try {
      await shutdownHandler?.(info);
    } finally {
      process.exit(0); // asked nicely and cleaned up: exit 0 so it counts as a clean stop
    }
  }

  function start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url as string);
      socket = ws;
      let welcomed = false;

      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for PiFi welcome'));
        ws.terminate();
      }, connectTimeoutMs);

      ws.on('open', () => {
        send({
          v: PROTOCOL_VERSION,
          type: 'hello',
          payload: { name: name as string, token: token as string, sdkVersion: SDK_VERSION, capabilities: [STREAMS_CAPABILITY] },
        });
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const chunk = decodeChunk(new Uint8Array(data as Buffer));
          if (chunk) streams.get(chunk.sid)?.push(new Uint8Array(chunk.data));
          return;
        }
        const parsed = parsePiMessage(data.toString());
        if (!parsed.ok) return;
        const msg = parsed.message;
        switch (msg.type) {
          case 'welcome':
            welcomed = true;
            clearTimeout(timer);
            send({ v: PROTOCOL_VERSION, type: 'ready' });
            resolve();
            break;
          case 'request':
            void handleRequest(msg.id, msg.payload, msg.session);
            break;
          case 'shutdown':
            void handleShutdown(msg.payload);
            break;
          case 'stream.open':
            handleStreamOpen(msg.sid, msg.op, msg.meta);
            break;
          case 'stream.accept': {
            const pending = opening.get(msg.sid);
            if (!pending) break;
            opening.delete(msg.sid);
            pending.resolve(streams.get(msg.sid) as PifiStream);
            break;
          }
          case 'stream.reject': {
            const pending = opening.get(msg.sid);
            opening.delete(msg.sid);
            streams.delete(msg.sid);
            pending?.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
            break;
          }
          case 'stream.end':
            streams.get(msg.sid)?.remoteEnd();
            break;
          case 'stream.abort': {
            const pending = opening.get(msg.sid);
            if (pending) {
              opening.delete(msg.sid);
              streams.delete(msg.sid);
              pending.reject(new Error(`stream aborted: ${msg.reason}`));
            } else {
              streams.get(msg.sid)?.remoteAbort(msg.reason);
            }
            break;
          }
          case 'error':
            break; // PiFi closes the socket right after; the close handler reports it
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (!welcomed) {
          reject(new Error(`PiFi closed the connection (${code} ${reason.toString()})`));
          return;
        }
        process.exit(1); // no reconnect in this phase: show up as a crash so PiFi can restart us
      });

      ws.on('error', (err) => {
        if (!welcomed) reject(err);
      });
    });
  }

  return {
    onRequest: (h) => { requestHandler = h; },
    onStream: (op, h) => { streamHandlers.set(op, h); },
    openStream: (session, op, meta) =>
      new Promise<PifiStream>((resolve, reject) => {
        const sid = nextSid;
        nextSid = nextSid >= 0xfffffffe ? 2 : nextSid + 2;
        streams.set(sid, newStream(sid, op));
        opening.set(sid, { resolve, reject });
        send({ v: PROTOCOL_VERSION, type: 'stream.open', sid, op, meta, session });
      }),
    onShutdown: (h) => { shutdownHandler = h; },
    emit: (eventName, data) => send({ v: PROTOCOL_VERSION, type: 'event', payload: { name: eventName, data } }),
    log: (level, message) => send({ v: PROTOCOL_VERSION, type: 'log', payload: { level, message } }),
    start,
  };
}
