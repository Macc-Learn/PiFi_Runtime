/**
 * The connection manager (Phase 3 §9.4): owns signaling, the session handshake,
 * the data channel and the heartbeat for ONE Pi, and keeps it connected.
 *
 *   idle -> connecting -> online -> (drop) -> reconnecting -> online ...
 *                                   (fatal: NOT_PAIRED / KEY_MISSING) -> offline
 *
 * Reconnect: exponential backoff 1 s -> 30 s with +/-20% jitter, reset after 60 s
 * online; immediately on tab-visible, network-online, or a missed heartbeat.
 * While not online, requests fail fast with DISCONNECTED (never auto-retried:
 * the caller decides whether something is safe to repeat).
 */
import type { ShellEnv } from './env.js';
import { isShellError, ShellError, type ShellErrorCode } from './errors.js';
import { openSession as defaultOpenSession, type OpenSession, type SessionInput } from './session.js';
import type { PiRecord } from './store.js';
import { WireClient } from './wireClient.js';

export type ConnState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface ConnStatus {
  state: ConnState;
  /** Why we are not online (drives the message the UI shows). */
  reason?: ShellErrorCode;
  retryInMs?: number;
}

export interface ConnectionOptions {
  pi: PiRecord;
  signalUrl: string;
  iceServers: string[];
  env: ShellEnv;
  /** Injectable for tests. */
  openSession?: (input: SessionInput) => Promise<OpenSession>;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  stableMs?: number;
  pingMs?: number;
}

/** Errors that retrying can't fix: the user has to re-pair. */
const FATAL: ShellErrorCode[] = ['NOT_PAIRED', 'KEY_MISSING', 'BAD_ANSWER'];

export class ConnectionManager {
  private status: ConnStatus = { state: 'idle' };
  private listeners = new Set<(s: ConnStatus) => void>();
  private wire?: WireClient;
  private pc?: RTCPeerConnection;
  private attempt = 0;
  private onlineSince?: number;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private connecting = false;

  constructor(private readonly o: ConnectionOptions) {}

  get state(): ConnStatus {
    return this.status;
  }

  /** The live client, or undefined while not online. */
  get client(): WireClient | undefined {
    return this.wire?.isOpen ? this.wire : undefined;
  }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
    this.set({ state: 'idle' });
  }

  /** Skip the backoff (tab became visible, network came back, user tapped retry). */
  reconnectNow(): void {
    if (!this.running || this.connecting || this.status.state === 'online') return;
    if (this.status.state === 'offline' && this.status.reason && FATAL.includes(this.status.reason)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.connect();
  }

  /** Forward a request; fails with DISCONNECTED when not online. */
  request(op: string, payload?: unknown, opts?: { app?: string; timeoutMs?: number }): Promise<unknown> {
    const c = this.client;
    if (!c) return Promise.reject(new ShellError('DISCONNECTED'));
    return c.request(op, payload, opts);
  }

  // -------------------------------------------------------------------------

  private set(s: ConnStatus): void {
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }

  private teardown(): void {
    const w = this.wire;
    this.wire = undefined;
    w?.close();
    this.pc?.close();
    this.pc = undefined;
  }

  private backoff(): number {
    const min = this.o.minBackoffMs ?? 1000;
    const max = this.o.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    if (base < max) this.attempt++;
    return Math.round(base * (0.8 + 0.4 * this.o.env.random()));
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;
    this.set({ state: this.status.state === 'idle' ? 'connecting' : 'reconnecting', reason: this.status.reason });
    try {
      const { pc, channel } = await (this.o.openSession ?? defaultOpenSession)({
        pi: this.o.pi, signalUrl: this.o.signalUrl, iceServers: this.o.iceServers, env: this.o.env,
      });
      if (!this.running) { pc.close(); return; }
      this.pc = pc;
      const wire = new WireClient(channel, { pingMs: this.o.pingMs });
      this.wire = wire;
      this.onlineSince = this.o.env.now();
      wire.onClose(() => this.onDropped(wire));
      this.set({ state: 'online' });
    } catch (err) {
      const code: ShellErrorCode = isShellError(err) ? err.code : 'UNREACHABLE';
      if (FATAL.includes(code)) {
        this.running = false;
        this.set({ state: 'offline', reason: code });
        return;
      }
      this.scheduleRetry(code);
    } finally {
      this.connecting = false;
    }
  }

  private onDropped(wire: WireClient): void {
    if (wire !== this.wire) return;
    this.teardown();
    if (!this.running) return;
    const onlineFor = this.onlineSince === undefined ? 0 : this.o.env.now() - this.onlineSince;
    this.onlineSince = undefined;
    const wasStable = onlineFor >= (this.o.stableMs ?? 60_000);
    if (wasStable) this.attempt = 0; // healthy for a while: start fresh
    // After a healthy connection, retry at once; a connection that keeps dropping backs off.
    this.scheduleRetry('DISCONNECTED', wasStable ? 0 : this.backoff());
  }

  private scheduleRetry(reason: ShellErrorCode, delay = this.backoff()): void {
    if (!this.running) return;
    this.set({ state: 'reconnecting', reason, retryInMs: delay });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
