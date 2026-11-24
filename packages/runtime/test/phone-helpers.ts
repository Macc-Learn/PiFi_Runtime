/** A fake phone for Pi-side tests: real keys and signatures, fake transport. */
import { randomBytes } from 'node:crypto';
import {
  b64urlDecode, b64urlEncode, decodeChunk, deviceIdFromSpki, fingerprintBytes, generateP256KeyPair, PAIR_ACCEPT_CONTEXT,
  pairProof, privateKeyFromPem, SESSION_PHONE_CONTEXT, SESSION_PI_CONTEXT, signedMessage, signP1363, spkiDerFromPem, utf8,
  verifyP1363, type PiToPhoneBody, type WireFrame,
} from '@pifi/protocol';
import type { Daemon } from '../src/daemon.js';
import { FakePeerTransport, type FakeChannel } from '../src/peer.js';

export const PHONE_FP = 'AB:'.repeat(31) + 'AB';

export class TestPhone {
  readonly spki: Uint8Array;
  readonly phoneId: string;
  private readonly key: ReturnType<typeof privateKeyFromPem>;

  constructor() {
    const pair = generateP256KeyPair();
    this.spki = new Uint8Array(spkiDerFromPem(pair.publicKeyPem));
    this.phoneId = deviceIdFromSpki(this.spki);
    this.key = privateKeyFromPem(pair.privateKeyPem);
  }

  pairRequest(deviceId: string, secret: string, label = 'Test phone'): { body: { k: 'pair.request'; phoneSpki: string; proof: string; challenge: string; label: string }; challenge: Uint8Array } {
    const challenge = new Uint8Array(randomBytes(16));
    return {
      challenge,
      body: { k: 'pair.request', phoneSpki: b64urlEncode(this.spki), proof: b64urlEncode(pairProof(secret, deviceId, this.spki)), challenge: b64urlEncode(challenge), label },
    };
  }

  /** What the shell checks before trusting a pair.accept. */
  static acceptIsValid(body: PiToPhoneBody, deviceId: string, phoneSpki: Uint8Array, challenge: Uint8Array): boolean {
    if (body.k !== 'pair.accept') return false;
    const piSpki = b64urlDecode(body.piSpki)!;
    if (deviceIdFromSpki(piSpki) !== deviceId) return false;
    return verifyP1363(piSpki, signedMessage(PAIR_ACCEPT_CONTEXT, utf8(deviceId), phoneSpki, challenge), b64urlDecode(body.signature)!);
  }

  sign(data: Uint8Array): string {
    return b64urlEncode(signP1363(this.key, data));
  }
}

export const offerSdp = (fp = PHONE_FP): string => `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${fp}\r\n`;

/** Collects frames from the phone end of a fake channel. */
export class WireClient {
  readonly frames: WireFrame[] = [];
  readonly chunks = new Map<number, Uint8Array[]>();
  private waiters: Array<() => void> = [];

  constructor(readonly ch: FakeChannel) {
    ch.onText((t) => { this.frames.push(JSON.parse(t) as WireFrame); this.wake(); });
    ch.onBinary((b) => {
      const c = decodeChunk(b)!;
      const list = this.chunks.get(c.sid) ?? [];
      list.push(new Uint8Array(c.data));
      this.chunks.set(c.sid, list);
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  send(frame: unknown): void {
    this.ch.sendText(JSON.stringify(frame));
  }

  async waitFor<T extends WireFrame>(pred: (f: WireFrame) => boolean, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(pred);
      if (found) return found as T;
      if (Date.now() > deadline) throw new Error('frame not received in time');
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 20); });
    }
  }

  async call(id: string, op: string, payload?: unknown, app?: string): Promise<WireFrame & { t: 'res' }> {
    this.send({ t: 'req', id, op, ...(app ? { app } : {}), ...(payload !== undefined ? { payload } : {}) });
    return this.waitFor((f) => f.t === 'res' && f.id === id);
  }
}

/** Collects every FakePeerTransport the daemon creates. */
export function fakeTransports(): { factory: () => FakePeerTransport; list: FakePeerTransport[] } {
  const list: FakePeerTransport[] = [];
  return { list, factory: () => { const t = new FakePeerTransport(); list.push(t); return t; } };
}

/** Pair `phone` with the daemon using a fresh code. */
export async function pair(daemon: Daemon, phone: TestPhone, peerId = 'p'.repeat(32), label?: string): Promise<PiToPhoneBody> {
  const code = daemon.pairing.create(60);
  const { body } = phone.pairRequest(daemon.identity.deviceId, code.secret, label);
  return daemon.handlePhoneBody(peerId, body);
}

/** Full session handshake; returns the verified answer and the phone's wire client. */
export async function openSession(
  daemon: Daemon,
  phone: TestPhone,
  transports: { list: FakePeerTransport[] },
  peerId = 'a'.repeat(32),
): Promise<{ client: WireClient; transport: FakePeerTransport }> {
  const np = new Uint8Array(randomBytes(16));
  const ch = await daemon.handlePhoneBody(peerId, { k: 'session.hello', phoneId: phone.phoneId, np: b64urlEncode(np) });
  if (ch.k !== 'session.challenge') throw new Error(`expected challenge, got ${ch.k}`);
  const nc = b64urlDecode(ch.nc)!;
  const sdp = offerSdp();
  const deviceId = daemon.identity.deviceId;
  const sig = phone.sign(signedMessage(SESSION_PHONE_CONTEXT, utf8(deviceId), utf8(phone.phoneId), np, nc, fingerprintBytes(sdp)!));
  const answer = await daemon.handlePhoneBody(peerId, { k: 'session.offer', sdp, sig });
  if (answer.k !== 'session.answer') throw new Error(`expected answer, got ${answer.k}`);
  // The phone's check: the Pi signed the answer's fingerprint with the key behind deviceId.
  const ok = verifyP1363(daemon.identity.publicKeyDer, signedMessage(SESSION_PI_CONTEXT, utf8(deviceId), utf8(phone.phoneId), np, nc, fingerprintBytes(answer.sdp)!), b64urlDecode(answer.sig)!);
  if (!ok) throw new Error('answer signature did not verify');
  const transport = transports.list[transports.list.length - 1]!;
  const client = new WireClient(transport.open());
  return { client, transport };
}
