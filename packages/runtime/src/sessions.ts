/**
 * Session setup (Phase 3 §4.3) and the set of live phone sessions (§5.2).
 *
 *   phone -> Pi   session.hello     { phoneId, np }
 *   Pi -> phone   session.challenge { nc }                single use, 30 s, bound to the relay peerId
 *   phone -> Pi   session.offer     { sdp, sig }          sig by the PHONE's key over
 *                                                         (deviceId, phoneId, np, nc, offer fingerprint)
 *   Pi -> phone   session.answer    { sdp, sig }          sig by the PI's key over
 *                                                         (deviceId, phoneId, np, nc, answer fingerprint)
 *
 * The signed fingerprints are the DTLS certificate hashes each side will use, so a
 * signaling server that swaps SDPs can't get either side to talk to it.
 *
 * Cheap work first, WebRTC last: a peer connection is only created AFTER the
 * phone's signature verified. Unknown phones still get a challenge, so a prober
 * can't tell which phone IDs are paired.
 */
import { randomBytes } from 'node:crypto';
import {
  b64urlDecode, b64urlEncode, fingerprintBytes, WIRE, SESSION_PHONE_CONTEXT, SESSION_PI_CONTEXT, signedMessage, utf8, verifyP1363,
  type PiToPhoneBody,
} from '@pifi/protocol';
import type { AppManager } from './appManager.js';
import type { Identity } from './identity.js';
import type { Logger } from './logger.js';
import type { PairedStore } from './pairedStore.js';
import type { PeerTransport, PeerTransportFactory } from './peer.js';
import { WireSession } from './wireSession.js';

const REJECT: PiToPhoneBody = { k: 'session.reject', reason: 'rejected' };
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 32;
const ATTEMPTS_PER_MINUTE = 5;
/** A verified offer whose data channel never opens is dropped after this. */
const CHANNEL_OPEN_TIMEOUT_MS = 20_000;

interface Challenge {
  phoneId: string;
  np: Uint8Array;
  nc: Uint8Array;
  at: number;
}

export interface SessionManagerOptions {
  identity: Identity;
  paired: PairedStore;
  manager: AppManager;
  transportFactory: PeerTransportFactory;
  iceServers: string[];
  maxSessions: number;
  idleMs: number;
  log: Logger;
  status: () => Promise<Record<string, unknown>>;
  now?: () => number;
  appRequestTimeoutMs?: number;
}

export class SessionManager {
  private readonly challenges = new Map<string, Challenge>(); // by relay peerId
  private readonly attempts = new Map<string, number[]>(); // by relay peerId
  /** Live sessions by phoneId (one per phone; a new one replaces the old). */
  private readonly sessions = new Map<string, { session: WireSession; transport: PeerTransport }>();
  private readonly now: () => number;

  constructor(private readonly o: SessionManagerOptions) {
    this.now = o.now ?? Date.now;
    // App events go to every session that subscribed to that app.
    o.manager.on('appEvent', (app: string, name: string, data: unknown) => {
      for (const { session } of this.sessions.values()) session.deliverEvent(app, name, data);
    });
    // An app opening a stream names the session (from a request it received).
    o.manager.on('appStreamOpen', (app: string, req: Parameters<WireSession['openFromApp']>[1]) => {
      const target = [...this.sessions.values()].find((s) => s.session.id === req.session);
      if (!target) return req.reject('NOT_FOUND', 'no such session');
      target.session.openFromApp(app, req);
    });
  }

  get count(): number {
    return [...this.sessions.values()].filter((s) => s.session.isOpen).length;
  }

  isConnected(phoneId: string): boolean {
    return this.sessions.get(phoneId)?.session.isOpen ?? false;
  }

  // -------------------------------------------------------------------------
  // Handshake (relay bodies)
  // -------------------------------------------------------------------------

  /** Too many handshake attempts from one relay peer? (5 per minute) */
  private overLimit(peerId: string): boolean {
    const t = this.now();
    const recent = (this.attempts.get(peerId) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    this.attempts.set(peerId, recent);
    if (this.attempts.size > 1000) {
      for (const [k, v] of this.attempts) if (v.every((x) => t - x >= 60_000)) this.attempts.delete(k);
    }
    return recent.length > ATTEMPTS_PER_MINUTE;
  }

  private sweepChallenges(): void {
    const t = this.now();
    for (const [peer, c] of this.challenges) if (t - c.at > CHALLENGE_TTL_MS) this.challenges.delete(peer);
  }

  hello(peerId: string, phoneId: string, npB64: string): PiToPhoneBody {
    if (this.overLimit(peerId)) return REJECT;
    const np = b64urlDecode(npB64);
    if (!np || np.length < 16) return REJECT;
    this.sweepChallenges();
    // One outstanding challenge per peer (a new hello replaces it), 32 overall.
    if (!this.challenges.has(peerId) && this.challenges.size >= MAX_CHALLENGES) return REJECT;
    const nc = new Uint8Array(randomBytes(16));
    // Note: answered even if phoneId is not paired. No oracle.
    this.challenges.set(peerId, { phoneId, np, nc, at: this.now() });
    return { k: 'session.challenge', nc: b64urlEncode(nc) };
  }

  async offer(peerId: string, sdp: string, sigB64: string): Promise<PiToPhoneBody> {
    const ch = this.challenges.get(peerId);
    this.challenges.delete(peerId); // single use, whatever happens next
    if (!ch || this.now() - ch.at > CHALLENGE_TTL_MS) return this.reject('no valid challenge');

    const phone = this.o.paired.get(ch.phoneId);
    if (!phone) return this.reject('unknown phone');
    const phoneSpki = b64urlDecode(phone.spki);
    const fp = fingerprintBytes(sdp);
    const sig = b64urlDecode(sigB64);
    if (!phoneSpki || !fp || !sig) return this.reject('bad offer');

    const { deviceId } = this.o.identity;
    const signed = signedMessage(SESSION_PHONE_CONTEXT, utf8(deviceId), utf8(ch.phoneId), ch.np, ch.nc, fp);
    if (!verifyP1363(phoneSpki, signed, sig)) return this.reject('bad signature');

    // ---- authenticated from here on ----
    // Counts sessions still opening too, so a burst of offers can't exceed the cap.
    if (!this.sessions.has(ch.phoneId) && this.sessions.size >= this.o.maxSessions) return this.reject('session limit');
    this.closePhone(ch.phoneId, 'replaced by a new session'); // new wins

    const transport = this.o.transportFactory();
    let answerSdp: string;
    try {
      ({ answerSdp } = await transport.acceptOffer(sdp, this.o.iceServers));
    } catch (err) {
      transport.close();
      return this.reject(`WebRTC setup failed: ${err instanceof Error ? err.message : err}`);
    }
    const afp = fingerprintBytes(answerSdp);
    if (!afp) {
      transport.close();
      return this.reject('our own answer has no usable fingerprint');
    }

    const session = new WireSession(ch.phoneId, {
      manager: this.o.manager,
      log: this.o.log,
      idleMs: this.o.idleMs,
      textRate: { burst: 200, perSec: 100 },
      appRequestTimeoutMs: this.o.appRequestTimeoutMs ?? WIRE.APP_REQUEST_TIMEOUT_MS,
      status: this.o.status,
      listPhones: (current) => this.listPhones(current),
      revokePhone: (id) => this.revoke(id),
    });
    const entry = { session, transport };
    this.sessions.set(ch.phoneId, entry);
    const forget = (): void => {
      if (this.sessions.get(ch.phoneId) === entry) this.sessions.delete(ch.phoneId);
      transport.close();
    };
    session.onClose(forget);
    transport.onClose(() => session.close('peer connection closed'));
    const openTimer = setTimeout(() => { if (!session.isOpen) session.close('data channel never opened'); }, CHANNEL_OPEN_TIMEOUT_MS);
    transport.onChannelOpen((channel) => {
      clearTimeout(openTimer);
      if (this.sessions.get(ch.phoneId) !== entry) return channel.close();
      session.attach(channel);
      this.o.paired.touch(ch.phoneId, this.now());
      this.o.log.info(`session open for phone ${ch.phoneId.slice(0, 8)}…`);
    });

    const piSig = this.o.identity.sign(signedMessage(SESSION_PI_CONTEXT, utf8(deviceId), utf8(ch.phoneId), ch.np, ch.nc, afp));
    return { k: 'session.answer', sdp: answerSdp, sig: b64urlEncode(piSig) };
  }

  private reject(why: string): PiToPhoneBody {
    this.o.log.warn(`session handshake rejected (${why})`);
    return REJECT;
  }

  // -------------------------------------------------------------------------
  // Phones
  // -------------------------------------------------------------------------

  listPhones(currentPhoneId?: string): Array<Record<string, unknown>> {
    return this.o.paired.list().map((p) => ({
      phoneId: p.phoneId,
      label: p.label,
      createdAt: p.createdAt,
      lastSeenAt: p.lastSeenAt,
      connected: this.isConnected(p.phoneId),
      ...(currentPhoneId !== undefined ? { current: p.phoneId === currentPhoneId } : {}),
    }));
  }

  /** Remove a paired phone and immediately end its live session. */
  revoke(phoneId: string): boolean {
    const had = this.o.paired.remove(phoneId);
    this.closePhone(phoneId, 'phone revoked');
    return had;
  }

  private closePhone(phoneId: string, reason: string): void {
    const existing = this.sessions.get(phoneId);
    if (!existing) return;
    this.sessions.delete(phoneId);
    existing.session.close(reason);
    existing.transport.close();
  }

  closeAll(): void {
    for (const phoneId of [...this.sessions.keys()]) this.closePhone(phoneId, 'daemon stopping');
  }
}
