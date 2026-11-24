/**
 * @pifi/client — for an app's web page running INSIDE the PiFi shell.
 *
 *   import { connect } from '@pifi/client';
 *   const pifi = await connect();
 *   const reply = await pifi.request('list', { path: '/' });
 *   const off = pifi.on('progress', (data) => { ... });
 *   const up = await pifi.openStream('upload', { name, size });
 *   await up.write(bytes); await up.end();
 *   for await (const chunk of await pifi.openStream('download', { path })) { ... }
 *
 * The page never sees keys and never talks to the Pi itself: it gets a
 * MessagePort from the shell, and the shell forwards everything to THIS app
 * only, over the shell's own connection. Chunking (16 KiB) and backpressure
 * are handled here and in the shell.
 *
 * No dependencies: the protocol constants are duplicated below on purpose so
 * this file can be dropped into any page as a plain ES module.
 */

const PORT_HELLO = 'pifi-hello';
const PORT_HANDOFF = 'pifi-port';
const VERSION = 1;
const MAX_CHUNK = 16 * 1024;
/** Chunks in flight before waiting for the shell's ack (must match the shell's window). */
const WINDOW = 16;

export type Status = 'online' | 'reconnecting';

export class PifiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PifiError';
  }
}

export interface UploadStream {
  write(chunk: Uint8Array): Promise<void>;
  /** Done sending. Resolves when the app has finished its side too. */
  end(): Promise<void>;
  abort(reason?: string): void;
}

export interface PifiStream extends UploadStream, AsyncIterable<Uint8Array> {}

export interface Pifi {
  request(op: string, payload?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  on(event: string, cb: (data: unknown) => void): () => void;
  onStatus(cb: (s: Status) => void): () => void;
  openStream(op: string, meta?: unknown): Promise<PifiStream>;
}

interface StreamState {
  queue: Uint8Array[];
  waiting?: { resolve: (r: IteratorResult<Uint8Array>) => void; reject: (e: Error) => void };
  remoteEnded: boolean;
  error?: Error;
  inFlight: number;
  ackWaiters: Array<() => void>;
  endWaiters: Array<() => void>;
  opened?: { resolve: () => void; reject: (e: Error) => void };
}

export interface ConnectOptions {
  /** How long to wait for the shell to hand over a port. */
  timeoutMs?: number;
}

/**
 * Ask the parent shell for a port. Rejects with code NOT_IN_SHELL when the page
 * was opened on its own: show "Open this app from your PiFi dashboard."
 */
export function connect(opts: ConnectOptions = {}): Promise<Pifi> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || window.parent === window) {
      return reject(new PifiError('NOT_IN_SHELL', 'Open this app from your PiFi dashboard.'));
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new PifiError('NOT_IN_SHELL', 'Open this app from your PiFi dashboard.'));
    }, opts.timeoutMs ?? 5000);
    function onMessage(ev: MessageEvent): void {
      // Only the parent shell may hand us a port.
      if (ev.source !== window.parent) return;
      const d = ev.data as { t?: unknown; v?: unknown } | null;
      if (!d || d.t !== PORT_HANDOFF || d.v !== VERSION || !ev.ports[0]) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(makeClient(ev.ports[0]));
    }
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ t: PORT_HELLO, v: VERSION }, '*');
  });
}

function makeClient(port: MessagePort): Pifi {
  let nextId = 1;
  let nextSid = 1;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const statusCbs = new Set<(s: Status) => void>();
  const streams = new Map<number, StreamState>();
  let status: Status = 'online';

  port.onmessage = (ev) => {
    const m = ev.data as { t: string; [k: string]: unknown };
    switch (m.t) {
      case 'res': {
        const p = pending.get(m.id as string);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id as string);
        if (m.ok) p.resolve(m.payload);
        else {
          const e = m.error as { code: string; message: string };
          p.reject(new PifiError(e.code, e.message));
        }
        return;
      }
      case 'evt':
        for (const cb of listeners.get(m.name as string) ?? []) cb(m.data);
        return;
      case 'status':
        status = m.status as Status;
        for (const cb of statusCbs) cb(status);
        return;
      case 's.ok':
        streams.get(m.sid as number)?.opened?.resolve();
        return;
      case 's.reject': {
        const st = streams.get(m.sid as number);
        streams.delete(m.sid as number);
        const e = m.error as { code: string; message: string };
        st?.opened?.reject(new PifiError(e.code, e.message));
        return;
      }
      case 's.ack': {
        const st = streams.get(m.sid as number);
        if (!st) return;
        st.inFlight--;
        st.ackWaiters.shift()?.();
        return;
      }
      case 's.data': {
        const st = streams.get(m.sid as number);
        if (!st || st.remoteEnded) return;
        const chunk = new Uint8Array(m.data as ArrayBuffer);
        if (st.waiting) { const w = st.waiting; st.waiting = undefined; w.resolve({ value: chunk, done: false }); }
        else st.queue.push(chunk);
        return;
      }
      case 's.end': {
        const st = streams.get(m.sid as number);
        if (!st) return;
        st.remoteEnded = true;
        st.waiting?.resolve({ value: undefined, done: true });
        st.waiting = undefined;
        for (const w of st.endWaiters.splice(0)) w();
        return;
      }
      case 's.abort': {
        const st = streams.get(m.sid as number);
        if (!st) return;
        streams.delete(m.sid as number);
        st.error = new PifiError('ABORTED', String(m.reason ?? 'aborted'));
        st.opened?.reject(st.error);
        st.waiting?.reject(st.error);
        for (const w of [...st.ackWaiters.splice(0), ...st.endWaiters.splice(0)]) w();
        return;
      }
    }
  };

  const request = (op: string, payload?: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> => {
    const id = (nextId++).toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new PifiError('TIMEOUT', 'no response in time')); }, opts.timeoutMs ?? 30_000);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ t: 'req', id, op, ...(payload !== undefined ? { payload } : {}) });
    });
  };

  return {
    request,
    on(event, cb) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      if ([...listeners.values()].every((s) => s.size === 0)) port.postMessage({ t: 'sub' });
      set.add(cb);
      return () => {
        set?.delete(cb);
        if ([...listeners.values()].every((s) => s.size === 0)) port.postMessage({ t: 'unsub' });
      };
    },
    onStatus(cb) {
      statusCbs.add(cb);
      cb(status);
      return () => statusCbs.delete(cb);
    },
    async openStream(op, meta) {
      const sid = nextSid++;
      const st: StreamState = { queue: [], remoteEnded: false, inFlight: 0, ackWaiters: [], endWaiters: [] };
      streams.set(sid, st);
      await new Promise<void>((resolve, reject) => {
        st.opened = { resolve, reject };
        port.postMessage({ t: 's.open', sid, op, ...(meta !== undefined ? { meta } : {}) });
      });
      st.opened = undefined;
      let ended = false;
      return {
        async write(chunk: Uint8Array) {
          for (let o = 0; o < chunk.length; o += MAX_CHUNK) {
            if (st.error) throw st.error;
            if (ended) throw new PifiError('ENDED', 'stream already ended');
            // Backpressure: at most WINDOW chunks un-acked by the shell.
            while (st.inFlight >= WINDOW) await new Promise<void>((r) => st.ackWaiters.push(r));
            if (st.error) throw st.error;
            const piece = chunk.slice(o, o + MAX_CHUNK);
            st.inFlight++;
            port.postMessage({ t: 's.data', sid, data: piece.buffer }, [piece.buffer]);
          }
        },
        async end() {
          if (!ended) { ended = true; port.postMessage({ t: 's.end', sid }); }
          if (st.error) throw st.error;
          if (!st.remoteEnded) await new Promise<void>((r) => st.endWaiters.push(r));
          if (st.error) throw st.error;
        },
        abort(reason = 'aborted by page') {
          streams.delete(sid);
          port.postMessage({ t: 's.abort', sid, reason: reason.slice(0, 200) });
        },
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              const c = st.queue.shift();
              if (c) return Promise.resolve({ value: c, done: false });
              if (st.error) return Promise.reject(st.error);
              if (st.remoteEnded) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve, reject) => { st.waiting = { resolve, reject }; });
            },
          };
        },
      };
    },
  };
}
