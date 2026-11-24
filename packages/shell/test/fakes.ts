/**
 * Test doubles for the shell core: an in-memory "signaling server + Pi" (the Pi
 * side uses the real Node crypto from @pifi/protocol), a fake WebSocket, a fake
 * RTCPeerConnection, and a fake iframe.
 */
import {
  b64urlDecode, b64urlEncode, decodeRelayBody, deviceIdFromSpki, encodeRelayBody, fingerprintBytes, generateP256KeyPair,
  pairProof, PAIR_ACCEPT_CONTEXT, PhoneToPiBodySchema, privateKeyFromPem, SESSION_PHONE_CONTEXT, SESSION_PI_CONTEXT,
  signedMessage, signP1363, spkiDerFromPem, utf8, verifyP1363, type PiToPhoneBody,
} from '@pifi/protocol';
import type { ShellEnv } from '../src/core/env.js';

export class FakePi {
  readonly deviceId: string;
  readonly spki: Uint8Array;
  private readonly key: ReturnType<typeof privateKeyFromPem>;
  online = true;
  secret = b64urlEncode(new Uint8Array(16).fill(7));
  mode: 'normal' | 'reject' | 'wrong-key' | 'bad-signature' | 'bad-answer' | 'session-reject' = 'normal';
  phones = new Map<string, Uint8Array>(); // phoneId -> spki
  queries = 0;
  /** Lets a test make the Pi look offline for the first N queries. */
  offlineForQueries = 0;
  private challenges = new Map<string, { np: Uint8Array; nc: Uint8Array; phoneId: string }>();

  constructor() {
    const p = generateP256KeyPair();
    this.spki = new Uint8Array(spkiDerFromPem(p.publicKeyPem));
    this.deviceId = deviceIdFromSpki(this.spki);
    this.key = privateKeyFromPem(p.privateKeyPem);
  }

  isOnline(): boolean {
    this.queries++;
    return this.online && this.queries > this.offlineForQueries;
  }

  handle(peerId: string, payload: string): PiToPhoneBody | undefined {
    const body = decodeRelayBody(PhoneToPiBodySchema, payload);
    if (!body) return undefined;
    if (body.k === 'pair.request') {
      const spki = b64urlDecode(body.phoneSpki)!;
      const expected = pairProof(this.secret, this.deviceId, spki);
      if (this.mode === 'reject' || b64urlEncode(expected) !== body.proof) return { k: 'pair.reject', reason: 'rejected' };
      this.phones.set(deviceIdFromSpki(spki), spki);
      const challenge = b64urlDecode(body.challenge)!;
      let signer = this.key;
      let piSpki = this.spki;
      if (this.mode === 'wrong-key') {
        const other = generateP256KeyPair();
        signer = privateKeyFromPem(other.privateKeyPem);
        piSpki = new Uint8Array(spkiDerFromPem(other.publicKeyPem));
      }
      const msg = signedMessage(PAIR_ACCEPT_CONTEXT, utf8(this.deviceId), spki, this.mode === 'bad-signature' ? new Uint8Array(16) : challenge);
      return { k: 'pair.accept', piSpki: b64urlEncode(piSpki), signature: b64urlEncode(signP1363(signer, msg)) };
    }
    if (body.k === 'session.hello') {
      const nc = new Uint8Array(16).map(() => Math.floor(Math.random() * 256));
      this.challenges.set(peerId, { np: b64urlDecode(body.np)!, nc, phoneId: body.phoneId });
      return { k: 'session.challenge', nc: b64urlEncode(nc) };
    }
    if (body.k === 'session.offer') {
      const ch = this.challenges.get(peerId);
      this.challenges.delete(peerId);
      const spki = ch && this.phones.get(ch.phoneId);
      const fp = fingerprintBytes(body.sdp);
      if (this.mode === 'session-reject' || !ch || !spki || !fp) return { k: 'session.reject', reason: 'rejected' };
      const ok = verifyP1363(spki, signedMessage(SESSION_PHONE_CONTEXT, utf8(this.deviceId), utf8(ch.phoneId), ch.np, ch.nc, fp), b64urlDecode(body.sig)!);
      if (!ok) return { k: 'session.reject', reason: 'rejected' };
      const answerFp = 'CD:'.repeat(31) + 'CD';
      const sdp = `v=0\r\na=fingerprint:sha-256 ${answerFp}\r\n`;
      const signedFp = this.mode === 'bad-answer' ? new Uint8Array(32) : fingerprintBytes(sdp)!;
      const sig = signP1363(this.key, signedMessage(SESSION_PI_CONTEXT, utf8(this.deviceId), utf8(ch.phoneId), ch.np, ch.nc, signedFp));
      return { k: 'session.answer', sdp, sig: b64urlEncode(sig) };
    }
    return undefined;
  }
}

/** A fake signaling server in front of one FakePi. */
export function fakeSignaling(pi: FakePi, opts: { unreachable?: boolean } = {}) {
  let peerCounter = 0;
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket extends EventTarget {
    readyState = 0;
    readonly peerId = (++peerCounter).toString(16).padStart(32, '0');
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      setTimeout(() => {
        if (opts.unreachable) { this.dispatchEvent(new Event('error')); return; }
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 0);
    }
    private deliver(msg: unknown): void {
      setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) })), 0);
    }
    send(raw: string): void {
      const m = JSON.parse(raw) as { type: string; deviceId: string; payload?: string };
      if (m.type === 'query') {
        const online = m.deviceId === pi.deviceId && pi.isOnline();
        this.deliver({ v: 1, type: 'status', deviceId: m.deviceId, online });
        if (!online) setTimeout(() => this.close(), 5);
      } else if (m.type === 'relay') {
        if (!pi.online) return this.deliver({ v: 1, type: 'error', code: 'target-offline', message: 'offline' });
        const reply = pi.handle(this.peerId, m.payload as string);
        if (reply) this.deliver({ v: 1, type: 'relay', deviceId: pi.deviceId, payload: encodeRelayBody(reply) });
      }
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.dispatchEvent(new Event('close')), 0);
    }
  }
  return { WebSocket: FakeWebSocket as unknown as ShellEnv['WebSocket'], sockets };
}

/** A data channel that opens when the answer is applied. Sends are recorded. */
export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
  onSend?: (data: string | ArrayBuffer) => void;
  send(data: string | ArrayBuffer): void { this.sent.push(data); this.onSend?.(data); }
  open(): void { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
  close(): void { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  /** Deliver a message from the "Pi". */
  receive(data: string | ArrayBuffer): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

export class FakeRTCPeerConnection extends EventTarget {
  static last?: FakeRTCPeerConnection;
  static neverConnect = false;
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote?: string;
  channel?: FakeDataChannel;
  closed = false;
  constructor(readonly config?: RTCConfiguration) { super(); FakeRTCPeerConnection.last = this; }
  createDataChannel(): FakeDataChannel { this.channel = new FakeDataChannel(); return this.channel; }
  async createOffer(): Promise<{ type: 'offer'; sdp: string }> { return { type: 'offer', sdp: `v=0\r\na=fingerprint:sha-256 ${'AB:'.repeat(31)}AB\r\n` }; }
  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; this.iceGatheringState = 'complete'; }
  async setRemoteDescription(d: { sdp: string }): Promise<void> {
    this.remote = d.sdp;
    if (!FakeRTCPeerConnection.neverConnect) setTimeout(() => this.channel?.open(), 0);
  }
  close(): void { this.closed = true; this.channel?.close(); }
}

export function makeEnv(pi: FakePi, opts: { unreachable?: boolean } = {}): ShellEnv & { sockets: unknown[] } {
  const sig = fakeSignaling(pi, opts);
  return {
    crypto: globalThis.crypto,
    WebSocket: sig.WebSocket,
    RTCPeerConnection: FakeRTCPeerConnection as unknown as ShellEnv['RTCPeerConnection'],
    now: () => Date.now(),
    random: () => 0.5,
    sockets: sig.sockets,
  };
}

/** A fake <iframe>: a fake window object plus a load event the test fires. */
export function fakeFrame() {
  const posted: Array<{ msg: unknown; transfer?: Transferable[] }> = [];
  const contentWindow = { postMessage: (msg: unknown, _origin: string, transfer?: Transferable[]) => posted.push({ msg, transfer }) };
  const loadCbs: Array<() => void> = [];
  const frame = {
    contentWindow,
    removed: false,
    addEventListener: (_t: 'load', cb: () => void) => loadCbs.push(cb),
    remove() { this.removed = true; },
    load: () => loadCbs.forEach((cb) => cb()),
    posted,
  };
  return frame;
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
