/**
 * @pifi/sdk — a tiny helper so app authors don't hand-write the PiFi protocol.
 *
 *   const app = createApp();
 *   app.onRequest(async (payload) => ({ echoed: payload }));
 *   app.onShutdown(async () => { ...cleanup... });
 *   await app.start();   // connect -> hello -> welcome -> ready
 *
 * The real contract is the JSON protocol in @pifi/protocol (documented in
 * docs/ARCHITECTURE.md); this file is just one convenient implementation of it.
 */
import WebSocket from 'ws';
import { encode, parsePiMessage, PROTOCOL_VERSION } from '@pifi/protocol';

export const SDK_VERSION = '0.1.0';

export type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;
export type ShutdownHandler = (info: { graceMs: number; reason: string }) => void | Promise<void>;

export interface CreateAppOptions {
  /** Defaults to env PIFI_URL (set by the runtime). */
  url?: string;
  /** Defaults to env PIFI_APP_NAME. */
  name?: string;
  /** Defaults to env PIFI_APP_TOKEN. */
  token?: string;
  /** How long to wait for `welcome` after connecting. */
  connectTimeoutMs?: number;
}

export interface PifiApp {
  /** Register the function that answers requests. Its return value becomes the response payload. */
  onRequest(handler: RequestHandler): void;
  /** Register cleanup to run when PiFi asks us to shut down. After it finishes we exit with code 0. */
  onShutdown(handler: ShutdownHandler): void;
  /** Send an unsolicited event to PiFi (forwarded to front-ends in later phases). */
  emit(name: string, data?: unknown): void;
  /** Send a structured log line to PiFi. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Connect to PiFi and announce readiness. Resolves once PiFi has accepted us. */
  start(): Promise<void>;
}

export function createApp(options: CreateAppOptions = {}): PifiApp {
  const url = options.url ?? process.env.PIFI_URL;
  const name = options.name ?? process.env.PIFI_APP_NAME;
  const token = options.token ?? process.env.PIFI_APP_TOKEN;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;

  if (!url || !name || !token) {
    // These come from the runtime's environment; missing means we weren't launched by PiFi.
    throw new Error('PIFI_URL, PIFI_APP_NAME and PIFI_APP_TOKEN must be set (are you running under PiFi?)');
  }

  let requestHandler: RequestHandler | undefined;
  let shutdownHandler: ShutdownHandler | undefined;
  let socket: WebSocket | undefined;

  function send(message: Parameters<typeof encode>[0]): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(message));
  }

  async function handleRequest(id: string, payload: unknown): Promise<void> {
    if (!requestHandler) {
      send({ v: PROTOCOL_VERSION, type: 'response', id, error: { code: 'NO_HANDLER', message: 'app has no request handler' } });
      return;
    }
    try {
      const result = await requestHandler(payload);
      send({ v: PROTOCOL_VERSION, type: 'response', id, payload: result });
    } catch (err) {
      // A throw becomes an error response; the app keeps running.
      const message = err instanceof Error ? err.message : String(err);
      send({ v: PROTOCOL_VERSION, type: 'response', id, error: { code: 'HANDLER_ERROR', message } });
    }
  }

  async function handleShutdown(info: { graceMs: number; reason: string }): Promise<void> {
    try {
      await shutdownHandler?.(info);
    } finally {
      // PiFi asked nicely and we cleaned up: exit 0 so it counts as a clean stop.
      process.exit(0);
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
        send({ v: PROTOCOL_VERSION, type: 'hello', payload: { name: name as string, token: token as string, sdkVersion: SDK_VERSION } });
      });

      ws.on('message', (data) => {
        const parsed = parsePiMessage(data.toString());
        if (!parsed.ok) return; // ignore garbage; PiFi never sends it
        const msg = parsed.message;
        switch (msg.type) {
          case 'welcome':
            welcomed = true;
            clearTimeout(timer);
            send({ v: PROTOCOL_VERSION, type: 'ready' });
            resolve();
            break;
          case 'request':
            void handleRequest(msg.id, msg.payload);
            break;
          case 'shutdown':
            void handleShutdown(msg.payload);
            break;
          case 'error':
            // PiFi will close the socket right after this; the close handler reports it.
            break;
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (!welcomed) {
          reject(new Error(`PiFi closed the connection (${code} ${reason.toString()})`));
          return;
        }
        // No reconnect logic in Phase 1: if PiFi goes away, exit non-zero so it shows as a crash.
        process.exit(1);
      });

      ws.on('error', (err) => {
        if (!welcomed) reject(err);
      });
    });
  }

  return {
    onRequest: (h) => { requestHandler = h; },
    onShutdown: (h) => { shutdownHandler = h; },
    emit: (eventName, data) => send({ v: PROTOCOL_VERSION, type: 'event', payload: { name: eventName, data } }),
    log: (level, message) => send({ v: PROTOCOL_VERSION, type: 'log', payload: { level, message } }),
    start,
  };
}
