/**
 * A short-lived phone connection to the signaling server: query a Pi, send and
 * receive relay bodies. The shell opens one only to pair or to set up a session,
 * and closes it as soon as the data channel is open (it frees a server slot).
 */
import {
  decodeRelayBody, encodeRelayBody, parseSignal, PiToPhoneBodySchema, ServerToPhoneSchema, SIGNAL_PROTOCOL_VERSION,
  type PhoneToPiBody, type PiToPhoneBody, type ServerToPhone,
} from '@pifi/protocol/browser';
import type { ShellEnv } from './env.js';
import { ShellError } from './errors.js';

export class SignalSocket {
  private inbox: ServerToPhone[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  private constructor(private readonly ws: WebSocket, readonly deviceId: string) {
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = parseSignal(ServerToPhoneSchema, ev.data);
      if (!msg) return;
      this.inbox.push(msg);
      this.wake();
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Connect. Fails with SERVER_UNREACHABLE if the server can't be reached in time. */
  static open(env: ShellEnv, url: string, deviceId: string, timeoutMs = 8000): Promise<SignalSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new env.WebSocket(url);
      } catch {
        return reject(new ShellError('SERVER_UNREACHABLE', 'bad signaling URL'));
      }
      const timer = setTimeout(() => { ws.close(); reject(new ShellError('SERVER_UNREACHABLE')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new SignalSocket(ws, deviceId)); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new ShellError('SERVER_UNREACHABLE')); });
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.closed && this.ws.readyState === 1) this.ws.send(JSON.stringify({ v: SIGNAL_PROTOCOL_VERSION, ...message }));
  }

  private async next<T extends ServerToPhone>(pred: (m: ServerToPhone) => m is T, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as T;
      if (this.closed) throw new ShellError('SERVER_UNREACHABLE', 'signaling connection closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new ShellError('TIMEOUT', 'no reply from the Pi in time');
      await new Promise<void>((r) => {
        // Clear the timeout when woken early, or a stale timer keeps Node (the fake phone) alive.
        const timer = setTimeout(r, left);
        this.waiters.push(() => { clearTimeout(timer); r(); });
      });
    }
  }

  /** Is the Pi online? (The server closes our socket right after if it isn't.) */
  async query(timeoutMs = 8000): Promise<boolean> {
    this.send({ type: 'query', deviceId: this.deviceId });
    const msg = await this.next((m): m is Extract<ServerToPhone, { type: 'status' }> => m.type === 'status', timeoutMs);
    return msg.online;
  }

  relay(body: PhoneToPiBody): void {
    this.send({ type: 'relay', deviceId: this.deviceId, payload: encodeRelayBody(body) });
  }

  /** Wait for the Pi's next body of one of `kinds`. A `target-offline` error means the Pi left. */
  async nextBody<K extends PiToPhoneBody['k']>(kinds: K[], timeoutMs = 15_000): Promise<Extract<PiToPhoneBody, { k: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await this.next((m): m is Extract<ServerToPhone, { type: 'relay' | 'error' }> => m.type === 'relay' || m.type === 'error', Math.max(1, deadline - Date.now()));
      if (msg.type === 'error') {
        if (msg.code === 'target-offline') throw new ShellError('PI_OFFLINE');
        continue;
      }
      const body = decodeRelayBody(PiToPhoneBodySchema, msg.payload);
      if (body && (kinds as string[]).includes(body.k)) return body as Extract<PiToPhoneBody, { k: K }>;
    }
  }

  close(): void {
    this.closed = true;
    try { this.ws.close(1000); } catch { /* already closed */ }
  }
}
