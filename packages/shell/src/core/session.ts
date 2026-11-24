/**
 * Session setup, phone side (Phase 3 §4.3): signed handshake over the signaling
 * relay, then a direct WebRTC data channel. No ICE trickling: we wait for
 * gathering to finish (max 5 s) and send one complete SDP.
 */
import {
  b64urlDecode, b64urlEncode, fingerprintBytes, SESSION_PHONE_CONTEXT, SESSION_PI_CONTEXT, signedMessage, utf8, WIRE,
} from '@pifi/protocol/browser';
import type { ShellEnv } from './env.js';
import { ShellError } from './errors.js';
import { randomBytes, sign, verifyP1363 } from './phoneCrypto.js';
import { SignalSocket } from './signal.js';
import { checkKey, type PiRecord } from './store.js';

export interface SessionInput {
  pi: PiRecord;
  signalUrl: string;
  iceServers: string[];
  env: ShellEnv;
  gatherTimeoutMs?: number;
  /** ICE/DTLS must finish within this, or we report UNREACHABLE. */
  connectTimeoutMs?: number;
}

export interface OpenSession {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
}

function waitForGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, timeoutMs); // send what we have
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
    };
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', (e) => { if (!e.candidate) check(); });
  });
}

function waitForOpen(channel: RTCDataChannel, pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (channel.readyState === 'open') return resolve();
    const fail = (): void => { clearTimeout(timer); reject(new ShellError('UNREACHABLE', "Couldn't connect directly. Some networks block direct connections.")); };
    const timer = setTimeout(fail, timeoutMs);
    channel.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed') fail(); });
  });
}

export async function openSession(input: SessionInput): Promise<OpenSession> {
  const { pi, env } = input;
  checkKey(pi);
  const piSpki = b64urlDecode(pi.piSpki);
  if (!piSpki) throw new ShellError('KEY_MISSING');

  const socket = await SignalSocket.open(env, input.signalUrl, pi.deviceId);
  let pc: RTCPeerConnection | undefined;
  try {
    if (!(await socket.query())) throw new ShellError('PI_OFFLINE');

    const np = randomBytes(env.crypto, 16);
    socket.relay({ k: 'session.hello', phoneId: pi.phoneId, np: b64urlEncode(np) });
    const ch = await socket.nextBody(['session.challenge', 'session.reject']);
    if (ch.k === 'session.reject') throw new ShellError('NOT_PAIRED');
    const nc = b64urlDecode(ch.nc);
    if (!nc) throw new ShellError('BAD_ANSWER');

    pc = new env.RTCPeerConnection({ iceServers: input.iceServers.map((urls) => ({ urls })) });
    const channel = pc.createDataChannel(WIRE.CHANNEL_LABEL, { ordered: true });
    channel.binaryType = 'arraybuffer';
    await pc.setLocalDescription(await pc.createOffer());
    await waitForGathering(pc, input.gatherTimeoutMs ?? 5000);
    const offerSdp = pc.localDescription?.sdp ?? '';
    const fp = fingerprintBytes(offerSdp);
    if (!fp) throw new ShellError('UNREACHABLE', 'this browser produced no usable DTLS fingerprint');

    const sig = await sign(env.crypto, pi.keyPair.privateKey, signedMessage(SESSION_PHONE_CONTEXT, utf8(pi.deviceId), utf8(pi.phoneId), np, nc, fp));
    socket.relay({ k: 'session.offer', sdp: offerSdp, sig: b64urlEncode(sig) });
    const answer = await socket.nextBody(['session.answer', 'session.reject']);
    if (answer.k === 'session.reject') throw new ShellError('NOT_PAIRED');

    // Before applying the answer: the Pi must have signed THIS answer's fingerprint.
    const afp = fingerprintBytes(answer.sdp);
    const asig = b64urlDecode(answer.sig);
    const ok = !!afp && !!asig && (await verifyP1363(env.crypto, piSpki, signedMessage(SESSION_PI_CONTEXT, utf8(pi.deviceId), utf8(pi.phoneId), np, nc, afp), asig));
    if (!ok) throw new ShellError('BAD_ANSWER', 'the Pi could not prove the connection is its own');
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    await waitForOpen(channel, pc, input.connectTimeoutMs ?? 15_000);
    return { pc, channel };
  } catch (err) {
    pc?.close();
    throw err;
  } finally {
    socket.close(); // the data channel doesn't need the server any more
  }
}
