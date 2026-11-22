/** Test plumbing: an in-process server, a queue-based WebSocket client, and fake Pi identities. */
import { WebSocket, type ClientOptions } from 'ws';
import {
  deviceIdFromSpki, generateP256KeyPair, privateKeyFromPem, registrationMessage, signP1363, spkiDerFromPem, toBase64url,
} from '@pifi/protocol';
import { createSignalingServer, type SignalingServer } from '../src/server.js';
import { loadServerConfig, type ServerConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export interface TestServer {
  server: SignalingServer;
  url: string;
  lines: string[];
  stop: () => Promise<void>;
}

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const lines: string[] = [];
  const cfg = loadServerConfig({}, { host: '127.0.0.1', port: 0, ...overrides });
  const server = createSignalingServer(cfg, { log: createLogger('debug', (l) => lines.push(l)) });
  const port = await server.listen();
  return { server, url: `ws://127.0.0.1:${port}/ws`, lines, stop: () => server.shutdown() };
}

type Msg = Record<string, unknown> & { type: string };

export class TestWs {
  private inbox: Msg[] = [];
  private waiters: Array<{ resolve: (m: Msg) => void; reject: (e: Error) => void }> = [];
  private isClosed = false;
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Msg;
      const w = this.waiters.shift();
      if (w) w.resolve(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.isClosed = true;
        for (const w of this.waiters.splice(0)) w.reject(new Error(`closed (${code})`));
        resolve({ code, reason: reason.toString() });
      });
    });
    ws.on('error', () => undefined);
  }

  static connect(url: string, opts: ClientOptions = {}): Promise<TestWs> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, opts);
      const client = new TestWs(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: 1, ...obj }));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  next(timeoutMs = 2000): Promise<Msg> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.isClosed) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message in time')), timeoutMs);
      this.waiters.push({
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** Resolve true if nothing arrives within `ms` (for "must not reply" checks). */
  async silentFor(ms: number): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    this.ws.close(1000);
  }
}

export interface FakePi {
  deviceId: string;
  publicKey: string;
  sign(nonce: string): string;
  /** Sign arbitrary bytes (to build wrong signatures). */
  signRaw(data: Buffer): string;
}

export function makePi(): FakePi {
  const { privateKeyPem, publicKeyPem } = generateP256KeyPair();
  const der = spkiDerFromPem(publicKeyPem);
  const key = privateKeyFromPem(privateKeyPem);
  const deviceId = deviceIdFromSpki(der);
  return {
    deviceId,
    publicKey: toBase64url(der),
    sign: (nonce) => toBase64url(signP1363(key, registrationMessage(nonce, deviceId))),
    signRaw: (data) => toBase64url(signP1363(key, data)),
  };
}

/** Connect and complete registration. Returns the socket plus the nonce/signature used (for log checks). */
export async function registerPi(url: string, pi: FakePi, opts: ClientOptions = {}): Promise<{ ws: TestWs; nonce: string; signature: string }> {
  const ws = await TestWs.connect(url, opts);
  ws.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
  const challenge = await ws.next();
  if (challenge.type !== 'challenge') throw new Error(`expected challenge, got ${challenge.type}`);
  const nonce = challenge.nonce as string;
  const signature = pi.sign(nonce);
  ws.send({ type: 'pi.auth', signature });
  const registered = await ws.next();
  if (registered.type !== 'registered') throw new Error(`expected registered, got ${registered.type}`);
  return { ws, nonce, signature };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
