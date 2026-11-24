/**
 * WebRTC behind an interface (Phase 3 §5.4).
 *
 * The session code only talks to `PeerTransport` / `PiChannel`, so the WebRTC
 * library can be swapped (node-datachannel today; `werift` is the documented
 * fallback) and the whole session layer can be tested with the in-process
 * FakePeerTransport, without any real networking.
 *
 * DTLS: libdatachannel only completes the handshake if the phone's certificate
 * matches the fingerprint in the offer SDP we were given, and that SDP's
 * fingerprint is what the phone signed. That is what makes swapped SDPs useless.
 */
import { WIRE } from '@pifi/protocol';

export interface PiChannel {
  sendText(s: string): void;
  sendBinary(b: Uint8Array): void;
  bufferedAmount(): number;
  setBufferedLowThreshold(n: number): void;
  onText(cb: (s: string) => void): void;
  onBinary(cb: (b: Uint8Array) => void): void;
  onBufferedLow(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface PeerTransport {
  /** Apply the phone's offer and return our answer, after ICE gathering has completed (no trickle). */
  acceptOffer(sdp: string, iceServers: string[]): Promise<{ answerSdp: string }>;
  onChannelOpen(cb: (ch: PiChannel) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type PeerTransportFactory = () => PeerTransport;

const GATHER_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// node-datachannel (libdatachannel) implementation
// ---------------------------------------------------------------------------

type Ndc = typeof import('node-datachannel');
let ndcModule: Ndc | undefined;

/**
 * Loaded lazily: a Pi without the native binary still runs apps, it just can't take
 * P2P sessions. Must be the ESM build (`import()`): loading the CommonJS build via
 * require() made PeerConnection.close() hang in testing (node-datachannel 0.33.6).
 */
async function ndc(): Promise<Ndc> {
  if (!ndcModule) {
    const mod = (await import('node-datachannel')) as Ndc & { default?: Ndc };
    ndcModule = (mod.default ?? mod) as Ndc;
  }
  return ndcModule;
}

/**
 * Stop libdatachannel's native threads. Without this, Node can't exit after the
 * first peer connection was created. Called by Daemon.stop(); safe if never loaded.
 */
export function shutdownPeerLibrary(): void {
  ndcModule?.cleanup();
}

export class NdcPeerTransport implements PeerTransport {
  private pc?: InstanceType<Ndc['PeerConnection']>;
  private channelCb?: (ch: PiChannel) => void;
  private closeCb?: () => void;
  private closed = false;

  async acceptOffer(sdp: string, iceServers: string[]): Promise<{ answerSdp: string }> {
    const { PeerConnection } = await ndc();
    const pc = new PeerConnection('pifi', { iceServers, maxMessageSize: WIRE.MAX_TEXT_BYTES + 1024 });
    this.pc = pc;

    pc.onDataChannel((dc) => {
      // Only our one channel. Anything else a phone tries to open is closed.
      if (dc.getLabel() !== WIRE.CHANNEL_LABEL) return void dc.close();
      const wrapped = wrapNdcChannel(dc);
      if (dc.isOpen()) this.channelCb?.(wrapped);
      else dc.onOpen(() => this.channelCb?.(wrapped));
    });
    pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed') this.close();
    });

    let done: () => void = () => undefined;
    const gathered = new Promise<void>((resolve) => { done = resolve; });
    const timer = setTimeout(done, GATHER_TIMEOUT_MS); // send what we have after 5 s
    pc.onGatheringStateChange((state) => { if (state === 'complete') done(); });
    pc.setRemoteDescription(sdp, 'offer'); // auto-negotiation creates the answer and starts gathering
    // Gathering can finish before the callback is ever delivered (seen on loopback), so check directly too.
    if (pc.gatheringState() === 'complete') done();
    await gathered;
    clearTimeout(timer);
    const local = pc.localDescription();
    if (!local?.sdp) throw new Error('no local description');
    return { answerSdp: local.sdp };
  }

  onChannelOpen(cb: (ch: PiChannel) => void): void {
    this.channelCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.pc?.close(); } catch { /* already closed */ }
    this.closeCb?.();
  }
}

function wrapNdcChannel(dc: ReturnType<InstanceType<Ndc['PeerConnection']>['createDataChannel']>): PiChannel {
  let textCb: (s: string) => void = () => undefined;
  let binCb: (b: Uint8Array) => void = () => undefined;
  dc.onMessage((msg) => {
    if (typeof msg === 'string') textCb(msg);
    else binCb(new Uint8Array(msg instanceof ArrayBuffer ? msg : msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength)));
  });
  return {
    sendText: (s) => { dc.sendMessage(s); },
    sendBinary: (b) => { dc.sendMessageBinary(b); },
    bufferedAmount: () => dc.bufferedAmount(),
    setBufferedLowThreshold: (n) => dc.setBufferedAmountLowThreshold(n),
    onText: (cb) => { textCb = cb; },
    onBinary: (cb) => { binCb = cb; },
    onBufferedLow: (cb) => dc.onBufferedAmountLow(cb),
    onClose: (cb) => dc.onClosed(cb),
    close: () => { try { dc.close(); } catch { /* already closed */ } },
  };
}

// ---------------------------------------------------------------------------
// In-process fake (tests)
// ---------------------------------------------------------------------------

/** One end of a linked pair of fake channels. Delivery is async, like the real thing. */
export class FakeChannel implements PiChannel {
  peer?: FakeChannel;
  buffered = 0;
  closed = false;
  readonly sentText: string[] = [];
  private textCb: (s: string) => void = () => undefined;
  private binCb: (b: Uint8Array) => void = () => undefined;
  private lowCb: () => void = () => undefined;
  private closeCbs: Array<() => void> = [];
  lowThreshold = 0;

  sendText(s: string): void {
    if (this.closed) return;
    this.sentText.push(s);
    const peer = this.peer;
    queueMicrotask(() => { if (peer && !peer.closed) peer.textCb(s); });
  }

  sendBinary(b: Uint8Array): void {
    if (this.closed) return;
    const copy = new Uint8Array(b);
    const peer = this.peer;
    queueMicrotask(() => { if (peer && !peer.closed) peer.binCb(copy); });
  }

  bufferedAmount(): number { return this.buffered; }
  setBufferedLowThreshold(n: number): void { this.lowThreshold = n; }
  onText(cb: (s: string) => void): void { this.textCb = cb; }
  onBinary(cb: (b: Uint8Array) => void): void { this.binCb = cb; }
  onBufferedLow(cb: () => void): void { this.lowCb = cb; }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }
  /** Test helper: pretend the buffer drained. */
  drain(): void { this.buffered = 0; this.lowCb(); }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
    this.peer?.close();
  }
}

export function fakeChannelPair(): [FakeChannel, FakeChannel] {
  const a = new FakeChannel();
  const b = new FakeChannel();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * Fake transport. The answer SDP carries a configurable fingerprint; the test
 * then calls `open()` to get the phone end of a fresh channel pair.
 */
export class FakePeerTransport implements PeerTransport {
  /** How many fakes were ever constructed (tests assert "no WebRTC work before auth"). */
  static created = 0;
  offerSdp?: string;
  closed = false;
  private channelCb?: (ch: PiChannel) => void;
  private closeCb?: () => void;

  constructor(readonly answerFingerprint = '0A:'.repeat(31) + '0A') {
    FakePeerTransport.created++;
  }

  async acceptOffer(sdp: string): Promise<{ answerSdp: string }> {
    this.offerSdp = sdp;
    return { answerSdp: `v=0\r\na=fingerprint:sha-256 ${this.answerFingerprint}\r\na=fake\r\n` };
  }

  onChannelOpen(cb: (ch: PiChannel) => void): void { this.channelCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }

  /** Open the data channel; returns the PHONE's end. */
  open(): FakeChannel {
    const [pi, phone] = fakeChannelPair();
    pi.onClose(() => this.close());
    this.channelCb?.(pi);
    return phone;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
  }
}
