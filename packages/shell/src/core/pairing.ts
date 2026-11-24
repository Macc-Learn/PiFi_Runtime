/**
 * Pairing, phone side (Phase 3 §4.2). Input comes from the QR link fragment
 * (#id=<deviceId>&s=<secret>); the UI removes the fragment before calling this.
 *
 * Steps (shown live on the Pair screen):
 *   server  reach the signaling server
 *   online  the Pi is online (retry every 5 s, up to 60 s)
 *   key     create this phone's key for this Pi (non-extractable)
 *   verify  the Pi proved it holds the key behind the QR's device ID
 *
 * Nothing is stored here: the caller saves the result only on success, so any
 * failure leaves no key behind.
 */
import { b64urlDecode, b64urlEncode, PAIR_ACCEPT_CONTEXT, signedMessage, utf8 } from '@pifi/protocol/browser';
import { sleep, type ShellEnv } from './env.js';
import { ShellError } from './errors.js';
import { exportSpki, generatePhoneKeyPair, idFromSpki, pairProof, randomBytes, verifyP1363 } from './phoneCrypto.js';
import { SignalSocket } from './signal.js';
import type { PiRecord } from './store.js';

export type PairStep = 'server' | 'online' | 'key' | 'verify';
export type StepState = 'active' | 'done' | 'failed';

export interface PairInput {
  deviceId: string;
  secret: string;
  label: string;
  signalUrl: string;
  env: ShellEnv;
  onStep?: (step: PairStep, state: StepState) => void;
  onOffline?: (retryInMs: number) => void;
  retryMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  /**
   * Tools only (the Node fake phone persists its key in a file). The shell never
   * passes this, so real phones always get a fresh non-extractable key.
   */
  keyPair?: CryptoKeyPair;
}

/** Parse `#id=...&s=...`. Returns undefined for anything that isn't a well-formed pair link. */
export function parsePairFragment(hash: string): { deviceId: string; secret: string } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const deviceId = params.get('id') ?? '';
  const secret = params.get('s') ?? '';
  if (!/^[a-z2-7]{52}$/.test(deviceId) || b64urlDecode(secret)?.length !== 16) return undefined;
  return { deviceId, secret };
}

export async function pairWithPi(input: PairInput): Promise<PiRecord> {
  const { env, deviceId } = input;
  const step = (s: PairStep, st: StepState): void => input.onStep?.(s, st);
  const retryMs = input.retryMs ?? 5000;
  const deadline = env.now() + (input.maxWaitMs ?? 60_000);
  const aborted = (): boolean => input.signal?.aborted === true;

  // 1 + 2: reach the server, wait for the Pi to be online.
  let socket: SignalSocket | undefined;
  for (;;) {
    if (aborted()) throw new ShellError('TIMEOUT', 'cancelled');
    step('server', 'active');
    try {
      socket = await SignalSocket.open(env, input.signalUrl, deviceId);
    } catch (e) {
      step('server', 'failed');
      throw e;
    }
    step('server', 'done');
    step('online', 'active');
    if (await socket.query().catch(() => false)) break;
    socket.close();
    if (env.now() + retryMs > deadline) {
      step('online', 'failed');
      throw new ShellError('PI_OFFLINE');
    }
    input.onOffline?.(retryMs);
    await sleep(retryMs);
  }
  step('online', 'done');

  try {
    // 3: this phone's key for THIS Pi (one key per Pi, so Pis can't link a phone).
    step('key', 'active');
    const keyPair = input.keyPair ?? (await generatePhoneKeyPair(env.crypto));
    const phoneSpki = await exportSpki(env.crypto, keyPair.publicKey);
    const phoneId = await idFromSpki(env.crypto, phoneSpki);
    const proof = await pairProof(env.crypto, input.secret, deviceId, phoneSpki);
    const challenge = randomBytes(env.crypto, 16);
    step('key', 'done');

    // 4: ask, then make the Pi prove itself.
    step('verify', 'active');
    socket.relay({
      k: 'pair.request',
      phoneSpki: b64urlEncode(phoneSpki),
      proof: b64urlEncode(proof),
      challenge: b64urlEncode(challenge),
      label: input.label.slice(0, 40) || 'My phone',
    });
    const reply = await socket.nextBody(['pair.accept', 'pair.reject']);
    if (reply.k === 'pair.reject') {
      step('verify', 'failed');
      throw new ShellError('REJECTED');
    }
    const piSpki = b64urlDecode(reply.piSpki);
    const signature = b64urlDecode(reply.signature);
    const genuine = !!piSpki && !!signature
      && (await idFromSpki(env.crypto, piSpki)) === deviceId // the key really is the one the QR named
      && (await verifyP1363(env.crypto, piSpki, signedMessage(PAIR_ACCEPT_CONTEXT, utf8(deviceId), phoneSpki, challenge), signature));
    if (!genuine) {
      step('verify', 'failed');
      throw new ShellError('NOT_GENUINE', 'This device could not prove it is your Pi.');
    }
    step('verify', 'done');
    const now = env.now();
    return { deviceId, piSpki: reply.piSpki, label: input.label.slice(0, 40) || 'My phone', keyPair, phoneId, createdAt: now, lastUsedAt: now };
  } finally {
    socket.close();
  }
}

/**
 * Read the pair link fragment and IMMEDIATELY erase it from the address bar and
 * history (replaceState), so the secret isn't left behind for anyone to find.
 */
export function consumePairFragment(win: { location: { hash: string; pathname: string; search: string }; history: { replaceState(data: unknown, unused: string, url?: string): void } }):
  { deviceId: string; secret: string } | undefined {
  const parsed = parsePairFragment(win.location.hash);
  if (win.location.hash) win.history.replaceState(null, '', win.location.pathname + win.location.search);
  return parsed;
}

/** Pair and store the result. The store is touched ONLY on success: a failed check leaves no key behind. */
export async function pairAndSave(store: import('./store.js').ShellStore, input: PairInput): Promise<PiRecord> {
  const rec = await pairWithPi(input);
  await store.putPi(rec);
  return rec;
}
