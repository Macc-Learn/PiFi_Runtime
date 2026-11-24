/**
 * Connection lifecycle + message routing (Phase 2 §4, §5, §8).
 *
 * Each WebSocket gets a `Conn`. Its FIRST valid message decides its role:
 *   pi.hello        -> Pi (must then pass the challenge to become online)
 *   query / relay   -> phone (anonymous; the server never learns who it is)
 * A connection can never change role.
 *
 * The server is deliberately dumb: it checks message SHAPES, proves a Pi owns
 * its key, and forwards opaque payloads. It never decodes a payload and has no
 * way to start or stop anything on a Pi.
 */
import { randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import {
  deviceIdFromSpki, FirstMessageSchema, fromBase64url, importP256Spki, MAX_RELAY_PAYLOAD_CHARS, parseSignal,
  PhoneMessageSchema, PiFollowupSchema, randomNonce, registrationMessage, SignalCloseCode, SIGNAL_PROTOCOL_VERSION,
  verifyP1363, type SignalErrorCode,
} from '@pifi/protocol';
import type { ServerConfig } from './config.js';
import { maskIp, shortId, type Logger } from './logger.js';
import type { PiConnection, PresenceStore } from './presence/PresenceStore.js';
import { TokenBucket, type IpRateLimiter } from './rateLimit.js';
import { ipKey } from './ipKey.js';

interface PiState {
  deviceId: string;
  publicKey: Buffer;
  /** Single-use challenge; deleted the moment it is checked. */
  nonce?: string;
  nonceIssuedAt?: number;
  registered: boolean;
  authTimer?: NodeJS.Timeout;
  /** The stable object stored in presence (compared by identity in setOffline). */
  handle: PiConnection;
}

interface PhoneState {
  /** Random per-connection id the Pi uses to answer; reveals nothing about the phone. */
  peerId: string;
  /** The only Pi this connection may talk to (locked on first use). */
  target?: string;
}

interface Conn {
  ws: WebSocket;
  ip: string;
  /** Grouping key for per-IP limits (IPv6 -> /64). */
  ipKey: string;
  /** Closes connections that never say what they are, and idle phones. */
  timer?: NodeJS.Timeout;
  role: 'unknown' | 'pi' | 'phone';
  alive: boolean;
  bucket: TokenBucket;
  closed: boolean;
  /** Messages are handled one at a time per connection (presence calls are async). */
  queue: Promise<void>;
  pi?: PiState;
  phone?: PhoneState;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

export class SignalingHub {
  readonly connections = new Set<Conn>();
  /** peerId -> phone connection, for routing Pi replies (this instance only). */
  private readonly phones = new Map<string, Conn>();
  /** Open phone / Pi connections per IP key (for MAX_PHONES_PER_IP / MAX_PIS_PER_IP). */
  private readonly phonesPerIp = new Map<string, number>();
  private readonly pisPerIp = new Map<string, number>();
  private phoneCount = 0;
  private keepalive?: NodeJS.Timeout;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly presence: PresenceStore,
    private readonly limiter: IpRateLimiter,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  handleConnection(ws: WebSocket, ip: string): void {
    if (!this.limiter.allowConnection(ip)) {
      this.log.warn('connection rate limit hit', { ip: maskIp(ip) });
      ws.close(SignalCloseCode.RATE_LIMITED, 'rate limited');
      return;
    }
    const conn: Conn = {
      ws,
      ip,
      ipKey: ipKey(ip),
      role: 'unknown',
      alive: true,
      bucket: new TokenBucket(this.cfg.messageBurst, this.cfg.messagesPerSecond, this.now),
      closed: false,
      queue: Promise.resolve(),
    };
    this.connections.add(conn);
    // Say what you are (pi.hello / query / relay) soon, or go away.
    conn.timer = setTimeout(() => {
      if (conn.role === 'unknown') this.violation(conn, 'no first message in time');
    }, this.cfg.firstMessageTimeoutMs);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (conn.closed) return;
      // Rate check happens synchronously, before queueing, so a flood can't pile up work.
      if (!conn.bucket.take()) {
        this.log.warn('message rate limit hit', { ip: maskIp(ip), role: conn.role });
        return this.closeConn(conn, SignalCloseCode.RATE_LIMITED, 'rate limited');
      }
      if (isBinary) return this.closeConn(conn, SignalCloseCode.PROTOCOL_VIOLATION, 'text frames only');
      const raw = rawToString(data);
      conn.queue = conn.queue
        .then(() => this.onMessage(conn, raw))
        .catch((err) => {
          this.log.error('message handling failed', { error: err instanceof Error ? err.message : String(err) });
          this.closeConn(conn, 1011, 'internal error');
        });
    });
    ws.on('close', () => { void this.onClose(conn); });
    ws.on('error', (err) => this.log.debug('socket error', { error: err.message }));
  }

  /** Server-side keepalive: ping everyone; terminate whoever didn't answer the previous ping. */
  startKeepalive(): void {
    this.keepalive = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.alive) {
          this.log.info('terminating unresponsive connection', { role: conn.role, deviceId: shortId(conn.pi?.deviceId) });
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
      }
    }, this.cfg.pingIntervalMs);
  }

  stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
  }

  /** Used on SIGTERM: politely close everything with the given code. */
  closeAll(code: number, reason: string): void {
    for (const conn of this.connections) this.closeConn(conn, code, reason);
  }

  terminateAll(): void {
    for (const conn of this.connections) conn.ws.terminate();
  }

  private closeConn(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.pi?.authTimer) clearTimeout(conn.pi.authTimer);
    if (conn.timer) clearTimeout(conn.timer);
    conn.ws.close(code, reason);
  }

  /** Send a last message, then close once it has been flushed to the socket. */
  private sendThenClose(conn: Conn, message: Record<string, unknown>, reason: string): void {
    if (conn.closed) return;
    conn.closed = true; // ignore anything else this socket sends
    if (conn.timer) clearTimeout(conn.timer);
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify({ v: SIGNAL_PROTOCOL_VERSION, ...message }), () => conn.ws.close(1000, reason));
  }

  /** Total phone connections (for the global phone cap). */
  get phoneConnections(): number {
    return this.phoneCount;
  }

  private bump(map: Map<string, number>, key: string, delta: number): void {
    const n = (map.get(key) ?? 0) + delta;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }

  private async onClose(conn: Conn): Promise<void> {
    conn.closed = true;
    this.connections.delete(conn);
    if (conn.timer) clearTimeout(conn.timer);
    if (conn.role === 'pi') this.bump(this.pisPerIp, conn.ipKey, -1); // counted at pi.hello, even if rejected
    if (conn.pi) {
      if (conn.pi.authTimer) clearTimeout(conn.pi.authTimer);
      if (conn.pi.registered) {
        // No-op if a newer connection for this deviceId has already replaced us.
        await this.presence.setOffline(conn.pi.deviceId, conn.pi.handle);
        this.log.info('pi offline', { deviceId: shortId(conn.pi.deviceId) });
      }
    }
    if (conn.phone) {
      this.phones.delete(conn.phone.peerId);
      this.phoneCount--;
      this.bump(this.phonesPerIp, conn.ipKey, -1);
    }
  }

  private send(conn: Conn, message: Record<string, unknown>): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ v: SIGNAL_PROTOCOL_VERSION, ...message }));
  }

  private sendError(conn: Conn, code: SignalErrorCode, message: string): void {
    this.send(conn, { type: 'error', code, message });
  }

  private violation(conn: Conn, why: string): void {
    this.log.info('protocol violation', { role: conn.role, why });
    this.closeConn(conn, SignalCloseCode.PROTOCOL_VIOLATION, 'protocol violation');
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    if (conn.closed) return;

    if (conn.role === 'unknown') {
      const msg = parseSignal(FirstMessageSchema, raw);
      if (!msg) return this.violation(conn, 'invalid first message');
      if (msg.type === 'pi.hello') return this.onPiHello(conn, msg.deviceId, msg.publicKey);
      if (!this.becomePhone(conn)) return;
      return this.onPhoneMessage(conn, msg);
    }

    if (conn.role === 'pi') {
      const msg = parseSignal(PiFollowupSchema, raw);
      if (!msg) return this.violation(conn, 'invalid pi message'); // includes a second pi.hello or phone-style messages
      if (msg.type === 'pi.auth') return this.onPiAuth(conn, msg.signature);
      return this.onPiRelay(conn, msg.peerId, msg.payload);
    }

    const msg = parseSignal(PhoneMessageSchema, raw);
    if (!msg) return this.violation(conn, 'invalid phone message'); // includes pi.* from a phone
    return this.onPhoneMessage(conn, msg);
  }

  // ---- Pi registration ----

  private registrationFailed(conn: Conn, reason: string): void {
    this.limiter.recordRegistrationFailure(conn.ip);
    this.log.warn('pi registration failed', { reason, deviceId: shortId(conn.pi?.deviceId), ip: maskIp(conn.ip) });
    this.closeConn(conn, SignalCloseCode.REGISTRATION_FAILED, 'registration failed');
  }

  private onPiHello(conn: Conn, deviceId: string, publicKeyB64: string): void {
    conn.role = 'pi';
    if (conn.timer) clearTimeout(conn.timer);
    const pis = this.pisPerIp.get(conn.ipKey) ?? 0;
    this.bump(this.pisPerIp, conn.ipKey, 1); // counted from pi.hello; uncounted on close
    if (pis >= this.cfg.maxPisPerIp) {
      this.log.warn('too many Pi connections from one IP', { ip: maskIp(conn.ip) });
      return this.closeConn(conn, SignalCloseCode.RATE_LIMITED, 'too many connections');
    }
    if (this.limiter.isRegistrationBlocked(conn.ip)) {
      this.log.warn('pi registration blocked for this IP', { ip: maskIp(conn.ip) });
      return this.closeConn(conn, SignalCloseCode.RATE_LIMITED, 'too many failed registrations');
    }
    const publicKey = fromBase64url(publicKeyB64);
    const handle: PiConnection = {
      send: (m) => { if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(m)); },
      close: (code, reason) => this.closeConn(conn, code, reason ?? ''),
    };
    conn.pi = { deviceId, publicKey: publicKey ?? Buffer.alloc(0), registered: false, handle };

    if (!publicKey || !importP256Spki(publicKey)) return this.registrationFailed(conn, 'invalid public key');
    // The deviceId is not a claim we trust: it must BE the hash of the key.
    if (deviceIdFromSpki(publicKey) !== deviceId) return this.registrationFailed(conn, 'deviceId does not match public key');

    conn.pi.nonce = randomNonce(); // lives only in this connection's memory
    conn.pi.nonceIssuedAt = this.now();
    conn.pi.authTimer = setTimeout(() => {
      if (!conn.pi?.registered) this.registrationFailed(conn, 'no pi.auth in time');
    }, this.cfg.authTimeoutMs);
    this.send(conn, { type: 'challenge', nonce: conn.pi.nonce });
  }

  private async onPiAuth(conn: Conn, signatureB64: string): Promise<void> {
    const pi = conn.pi as PiState;
    if (pi.registered || !pi.nonce) return this.violation(conn, 'unexpected pi.auth');
    const nonce = pi.nonce;
    const issuedAt = pi.nonceIssuedAt ?? 0;
    pi.nonce = undefined; // single use, whatever the outcome
    if (pi.authTimer) clearTimeout(pi.authTimer);

    if (this.now() - issuedAt > this.cfg.nonceTtlMs) return this.registrationFailed(conn, 'challenge expired');
    const signature = fromBase64url(signatureB64);
    if (!signature || !verifyP1363(pi.publicKey, registrationMessage(nonce, pi.deviceId), signature)) {
      return this.registrationFailed(conn, 'bad signature');
    }

    // Only the key holder gets here, so letting the newest connection win is safe.
    const previous = await this.presence.getConnection(pi.deviceId);
    await this.presence.setOnline(pi.deviceId, pi.handle);
    pi.registered = true;
    if (previous && previous !== pi.handle) previous.close(SignalCloseCode.REPLACED, 'replaced by a newer connection');
    this.send(conn, { type: 'registered', deviceId: pi.deviceId });
    this.log.info('pi registered', { deviceId: shortId(pi.deviceId), ip: maskIp(conn.ip), replaced: Boolean(previous) });
  }

  private onPiRelay(conn: Conn, peerId: string, payload: string): void {
    const pi = conn.pi as PiState;
    if (!pi.registered) return this.violation(conn, 'relay before registration');
    if (payload.length > MAX_RELAY_PAYLOAD_CHARS) return this.sendError(conn, 'payload-too-large', 'payload too large');
    const phone = this.phones.get(peerId);
    // A Pi may only answer phones that are talking to IT.
    if (!phone || phone.closed || phone.phone?.target !== pi.deviceId) return this.sendError(conn, 'peer-gone', 'that phone is no longer connected');
    this.send(phone, { type: 'relay', deviceId: pi.deviceId, payload });
  }

  // ---- phones ----

  private becomePhone(conn: Conn): boolean {
    if (conn.timer) clearTimeout(conn.timer);
    const count = this.phonesPerIp.get(conn.ipKey) ?? 0;
    if (count >= this.cfg.maxPhonesPerIp || this.phoneCount >= this.cfg.maxPhoneConnections) {
      this.log.warn('phone connection cap reached', { ip: maskIp(conn.ip), perIp: count >= this.cfg.maxPhonesPerIp });
      this.closeConn(conn, SignalCloseCode.RATE_LIMITED, 'too many connections');
      return false;
    }
    conn.role = 'phone';
    conn.phone = { peerId: randomBytes(16).toString('hex') };
    this.phones.set(conn.phone.peerId, conn);
    this.phoneCount++;
    this.bump(this.phonesPerIp, conn.ipKey, 1);
    return true;
  }

  /** Phones exist only to reach a Pi; an idle one is just holding a slot. */
  private touchPhone(conn: Conn): void {
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = setTimeout(() => this.closeConn(conn, 1000, 'idle'), this.cfg.phoneIdleTimeoutMs);
  }

  private async onPhoneMessage(conn: Conn, msg: { type: 'query' | 'relay'; deviceId: string; payload?: string }): Promise<void> {
    const phone = conn.phone as PhoneState;
    this.touchPhone(conn);
    // One connection, one Pi: stops a single socket from probing or spraying many Pis.
    const first = phone.target === undefined;
    if (first) phone.target = msg.deviceId;
    if (phone.target !== msg.deviceId) return this.sendError(conn, 'target-mismatch', 'this connection is bound to another device');

    if (msg.type === 'query') {
      const online = await this.presence.isOnline(msg.deviceId);
      const status = { type: 'status', deviceId: msg.deviceId, online };
      // A phone whose Pi is offline has no reason to stay: answer, then free the slot.
      if (first && !online) return this.sendThenClose(conn, status, 'target offline');
      this.send(conn, status);
      return;
    }
    const payload = msg.payload as string;
    if (payload.length > MAX_RELAY_PAYLOAD_CHARS) return this.sendError(conn, 'payload-too-large', 'payload too large');
    const pi = await this.presence.getConnection(msg.deviceId);
    if (!pi) {
      const error = { type: 'error', code: 'target-offline', message: 'that device is offline' };
      if (first) return this.sendThenClose(conn, error, 'target offline');
      return this.send(conn, error);
    }
    pi.send({ v: SIGNAL_PROTOCOL_VERSION, type: 'relay', peerId: phone.peerId, payload });
  }
}
