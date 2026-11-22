/**
 * Signaling client (Phase 2 §7): the Pi's single OUTBOUND connection to the
 * central signaling server. Nothing ever connects in to the Pi; the Pi dials out
 * and keeps the socket open, and an open socket means "this Pi is online".
 *
 * State machine:
 *
 *   disabled (no PIFI_SIGNAL_URL)
 *   connecting -> authenticating -> online
 *        ^              |             |
 *        +--- backoff <-+-------------+   (any close / error)
 *
 * Registration (see docs/signaling.md): send pi.hello {deviceId, publicKey},
 * receive challenge {nonce}, reply pi.auth {signature over
 * "pifi-register-v1" || nonce || deviceId}, receive `registered`.
 *
 * The server can never start or stop apps. This client only relays opaque
 * messages, and in Phase 2 it drops every relay except a dev-only echo.
 */
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  fromBase64url, parseSignal, registrationMessage, ServerToPiSchema, SignalCloseCode,
  SIGNAL_PROTOCOL_VERSION, toBase64url,
} from '@pifi/protocol';
import type { Identity } from './identity.js';
import type { Logger } from './logger.js';

export type SignalingStateName = 'disabled' | 'connecting' | 'authenticating' | 'online' | 'backoff';

export interface SignalingState {
  state: SignalingStateName;
  /** Epoch ms when the current state began. */
  since: number;
  url?: string;
  /** Why the last connection ended (no secrets in here). */
  lastError?: string;
  /** In `backoff`: how long until the next attempt. */
  retryInMs?: number;
}

/** Add +/-20% randomness so a thousand Pis dropped at once don't all retry in the same millisecond. */
export function jitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (0.8 + 0.4 * random()));
}

/** Exponential backoff: min, 2*min, 4*min ... capped at max, each with jitter. */
export class Backoff {
  private attempt = 0;
  constructor(private readonly minMs: number, private readonly maxMs: number, private readonly random: () => number = Math.random) {}

  next(): number {
    const base = Math.min(this.maxMs, this.minMs * 2 ** this.attempt);
    if (base < this.maxMs) this.attempt++; // stop counting once capped (no overflow)
    return jitter(base, this.random);
  }

  maxDelay(): number {
    return jitter(this.maxMs, this.random);
  }

  reset(): void {
    this.attempt = 0;
  }
}

export interface SignalingClientOptions {
  /** Undefined -> client disabled, daemon behaves exactly like Phase 1. */
  url?: string;
  identity: Identity;
  log: Logger;
  /** Enables the dev-only echo handler. */
  dev: boolean;
  pingMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Online this long -> the backoff resets. */
  stableMs?: number;
  /** After being replaced (4011), wait at least this long. */
  replacedWaitMs?: number;
  /** Give up after this many 4011s in a row (two copies of one Pi must not fight forever). */
  maxReplacedInARow?: number;
  /** After 4100 (server restarting), reconnect after a random 0..this ms. */
  restartJitterMaxMs?: number;
  /** Not registered this long after the socket opened -> drop and retry. */
  handshakeTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface RelayMessage {
  peerId: string;
  payload: string;
}

export class SignalingClient extends EventEmitter {
  private ws?: WebSocket;
  private status: SignalingState;
  private readonly backoff: Backoff;
  private readonly now: () => number;
  private readonly random: () => number;
  private onlineSince?: number;
  private replacedInARow = 0;
  private stopped = false;
  private alive = true;
  private retryTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private handshakeTimer?: NodeJS.Timeout;

  constructor(private readonly opts: SignalingClientOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.backoff = new Backoff(opts.backoffMinMs, opts.backoffMaxMs, this.random);
    this.status = { state: 'disabled', since: this.now(), url: opts.url };
    if (opts.dev) this.on('relay', (m: RelayMessage) => this.devEcho(m));
  }

  getState(): SignalingState {
    return { ...this.status };
  }

  start(): void {
    if (!this.opts.url) {
      this.opts.log.info('signaling disabled (PIFI_SIGNAL_URL not set)');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  /** Close with 1000 and clear every timer. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once('close', () => { clearTimeout(force); resolve(); });
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000, 'pifi stopping');
      });
    }
    this.setState('disabled');
  }

  /** Send an opaque payload to a phone (via the server). Only possible while online. */
  relay(peerId: string, payload: string): boolean {
    if (this.status.state !== 'online') return false;
    return this.send({ v: SIGNAL_PROTOCOL_VERSION, type: 'relay', peerId, payload });
  }

  // -------------------------------------------------------------------------

  private setState(state: SignalingStateName, extra: Partial<SignalingState> = {}): void {
    this.status = { state, since: this.now(), url: this.opts.url, lastError: this.status.lastError, ...extra };
    this.emit('state', this.getState());
  }

  private send(message: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.pingTimer = undefined;
    this.handshakeTimer = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url as string, { handshakeTimeout: 10_000 });
    } catch (err) {
      // e.g. a malformed URL. Treat it like any failed connection.
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect(this.backoff.next());
      return;
    }
    this.ws = ws;
    this.alive = true;

    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.setState('authenticating');
      const { deviceId, publicKeyDer } = this.opts.identity;
      this.send({ v: SIGNAL_PROTOCOL_VERSION, type: 'pi.hello', deviceId, publicKey: toBase64url(publicKeyDer) });

      // Our own keepalive, in addition to the server's pings: notices a dead server
      // (e.g. Wi-Fi gone) without waiting for TCP to time out.
      this.pingTimer = setInterval(() => {
        if (!this.alive) return void ws.terminate();
        this.alive = false;
        ws.ping();
      }, this.opts.pingMs);

      this.handshakeTimer = setTimeout(() => {
        if (this.status.state !== 'online') {
          this.status.lastError = 'registration timed out';
          ws.terminate();
        }
      }, this.opts.handshakeTimeoutMs ?? 15_000);
    });

    ws.on('pong', () => { this.alive = true; });
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    ws.on('error', (err) => {
      // A 'close' event always follows; just remember why.
      this.status.lastError = err.message;
      this.opts.log.debug(`signaling socket error: ${err.message}`);
    });
    ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (ws !== this.ws) return;
    const msg = parseSignal(ServerToPiSchema, raw);
    if (!msg) return void this.opts.log.warn('signaling: ignoring an invalid message from the server');

    switch (msg.type) {
      case 'challenge': {
        if (this.status.state !== 'authenticating') return;
        const { deviceId } = this.opts.identity;
        const signature = this.opts.identity.sign(registrationMessage(msg.nonce, deviceId));
        this.send({ v: SIGNAL_PROTOCOL_VERSION, type: 'pi.auth', signature: toBase64url(signature) });
        return;
      }
      case 'registered':
        if (msg.deviceId !== this.opts.identity.deviceId) return; // not about us; ignore
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.onlineSince = this.now();
        this.status.lastError = undefined;
        this.setState('online');
        this.opts.log.info(`signaling: online as ${msg.deviceId.slice(0, 8)}…`);
        return;
      case 'relay':
        if (this.status.state === 'online') this.emit('relay', { peerId: msg.peerId, payload: msg.payload } satisfies RelayMessage);
        return;
      case 'error':
        this.opts.log.warn(`signaling: server error ${msg.code}`);
        return;
    }
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return; // an old socket we already replaced
    this.ws = undefined;
    this.clearTimers();
    if (this.stopped) return;

    // A connection that stayed up long enough means things are healthy again.
    const onlineFor = this.onlineSince === undefined ? 0 : this.now() - this.onlineSince;
    this.onlineSince = undefined;
    if (onlineFor >= (this.opts.stableMs ?? 60_000)) {
      this.backoff.reset();
      this.replacedInARow = 0;
    }
    if (code !== 1006 || !this.status.lastError) this.status.lastError = `closed (${code}${reason ? ` ${reason}` : ''})`;

    let delay: number;
    switch (code) {
      case SignalCloseCode.SERVER_RESTARTING:
        // The server is redeploying, not failing: come back promptly (spread out a little).
        delay = Math.round(this.random() * (this.opts.restartJitterMaxMs ?? 3000));
        break;
      case SignalCloseCode.REPLACED:
        this.replacedInARow++;
        if (this.replacedInARow > (this.opts.maxReplacedInARow ?? 3)) {
          this.opts.log.error('signaling: replaced by another connection too many times in a row; is this identity running on two devices? giving up until restart');
          this.setState('disabled', { lastError: 'replaced by another connection too many times' });
          return;
        }
        delay = Math.max(this.opts.replacedWaitMs ?? 30_000, this.backoff.next());
        break;
      case SignalCloseCode.REGISTRATION_FAILED:
        this.opts.log.error('signaling: the server rejected our registration (4010); retrying at maximum backoff');
        delay = this.backoff.maxDelay();
        break;
      default:
        delay = this.backoff.next();
    }
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped) return;
    this.setState('backoff', { retryInMs: delay });
    this.opts.log.info(`signaling: reconnecting in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  /**
   * DEV ONLY (PIFI_DEV=1): answer {"kind":"echo","data":...} with {"kind":"echo-reply","data":...}
   * so the test client has something to talk to. Everything else is dropped. Real,
   * authenticated handling of phone messages arrives in Phase 3.
   */
  private devEcho({ peerId, payload }: RelayMessage): void {
    const bytes = fromBase64url(payload);
    if (!bytes) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { kind?: unknown }).kind !== 'echo') return;
    const reply = { kind: 'echo-reply', data: (parsed as { data?: unknown }).data };
    this.relay(peerId, toBase64url(Buffer.from(JSON.stringify(reply), 'utf8')));
  }
}
