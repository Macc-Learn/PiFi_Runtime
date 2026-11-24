/** Shell core: WebCrypto vs the shared vectors, pairing, fragment handling, consent, KEY_MISSING, session checks. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { b64urlDecode, signedMessage, utf8, SESSION_PHONE_CONTEXT } from '@pifi/protocol/browser';
import { idFromSpki, pairProof, verifyP1363 } from '../src/core/phoneCrypto.js';
import { consumePairFragment, pairAndSave, parsePairFragment } from '../src/core/pairing.js';
import { openSession } from '../src/core/session.js';
import { MemoryStore, needsConsent, recordConsent, type PiRecord } from '../src/core/store.js';
import { isShellError } from '../src/core/errors.js';
import { FakePi, FakeRTCPeerConnection, makeEnv } from './fakes.js';

// vitest runs from packages/shell; happy-dom gives import.meta.url a non-file scheme.
const V = JSON.parse(readFileSync(path.resolve(process.cwd(), '../protocol/test/vectors.json'), 'utf8'));
const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('WebCrypto agrees with the shared (Python/OpenSSL) vectors', () => {
  it('pair proof, phoneId, P1363 signature, signedMessage', async () => {
    const p = V.pairProof;
    const spki = b64urlDecode(p.phoneSpki)!;
    expect(toHex(await pairProof(crypto, p.secret, p.deviceId, spki))).toBe(toHex(b64urlDecode(p.expectedProof)!));
    expect(await idFromSpki(crypto, spki)).toBe(V.phoneId.expected);
    expect(await verifyP1363(crypto, b64urlDecode(V.p1363.spki)!, utf8(V.p1363.message_utf8), b64urlDecode(V.p1363.signature)!)).toBe(true);
    expect(await verifyP1363(crypto, b64urlDecode(V.p1363.spki)!, utf8('tampered'), b64urlDecode(V.p1363.signature)!)).toBe(false);
    const s = V.sessionPhone;
    expect(toHex(signedMessage(SESSION_PHONE_CONTEXT, utf8(s.deviceId), utf8(s.phoneId), b64urlDecode(s.np)!, b64urlDecode(s.nc)!, hex(s.fingerprint_hex)))).toBe(s.expected_hex);
  });
});

describe('pair link fragment', () => {
  it('is parsed strictly and removed from the address bar at once', () => {
    const id = 'a'.repeat(52);
    const calls: string[] = [];
    const win = { location: { hash: `#id=${id}&s=${'A'.repeat(21)}w`, pathname: '/PiFi_Runtime/pair/', search: '' }, history: { replaceState: (_d: unknown, _u: string, url?: string) => calls.push(url ?? '') } };
    expect(consumePairFragment(win)).toEqual({ deviceId: id, secret: 'A'.repeat(21) + 'w' });
    expect(calls).toEqual(['/PiFi_Runtime/pair/']);
    expect(parsePairFragment('#id=BAD&s=x')).toBeUndefined();
    expect(parsePairFragment(`#id=${id}&s=short`)).toBeUndefined();
    // Real happy-dom window: the fragment is gone from location and history.
    window.history.replaceState(null, '', `/pair/#id=${id}&s=${'A'.repeat(21)}w`);
    expect(consumePairFragment(window)?.deviceId).toBe(id);
    expect(window.location.hash).toBe('');
  });
});

async function paired(pi: FakePi, store = new MemoryStore()): Promise<{ rec: PiRecord; store: MemoryStore }> {
  const env = makeEnv(pi);
  const rec = await pairAndSave(store, { deviceId: pi.deviceId, secret: pi.secret, label: 'Test', signalUrl: 'ws://x', env });
  return { rec, store };
}

describe('pairing state machine (against a fake Pi)', () => {
  it('succeeds, walks all four steps, stores a NON-extractable key', async () => {
    const pi = new FakePi();
    const steps: string[] = [];
    const store = new MemoryStore();
    const rec = await pairAndSave(store, { deviceId: pi.deviceId, secret: pi.secret, label: 'Alice', signalUrl: 'ws://x', env: makeEnv(pi), onStep: (s, st) => steps.push(`${s}:${st}`) });
    expect(steps).toEqual(['server:active', 'server:done', 'online:active', 'online:done', 'key:active', 'key:done', 'verify:active', 'verify:done']);
    expect(rec.keyPair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', rec.keyPair.privateKey)).rejects.toThrow();
    expect(await store.getPi(pi.deviceId)).toBe(rec);
    expect(pi.phones.has(rec.phoneId)).toBe(true);
  });

  for (const [mode, code] of [['reject', 'REJECTED'], ['wrong-key', 'NOT_GENUINE'], ['bad-signature', 'NOT_GENUINE']] as const) {
    it(`${mode} -> ${code}, and nothing is stored`, async () => {
      const pi = new FakePi();
      pi.mode = mode;
      const store = new MemoryStore();
      const err = await pairAndSave(store, { deviceId: pi.deviceId, secret: pi.secret, label: 'x', signalUrl: 'ws://x', env: makeEnv(pi) }).catch((e) => e);
      expect(isShellError(err, code)).toBe(true);
      expect(store.pis.size).toBe(0);
    });
  }

  it('waits for an offline Pi (retrying) and gives up with PI_OFFLINE', async () => {
    const pi = new FakePi();
    pi.offlineForQueries = 2;
    const offline: number[] = [];
    const rec = await pairAndSave(new MemoryStore(), { deviceId: pi.deviceId, secret: pi.secret, label: 'x', signalUrl: 'ws://x', env: makeEnv(pi), retryMs: 10, onOffline: (ms) => offline.push(ms) });
    expect(offline).toEqual([10, 10]);
    expect(rec.deviceId).toBe(pi.deviceId);

    const gone = new FakePi();
    gone.online = false;
    const err = await pairAndSave(new MemoryStore(), { deviceId: gone.deviceId, secret: gone.secret, label: 'x', signalUrl: 'ws://x', env: makeEnv(gone), retryMs: 10, maxWaitMs: 50 }).catch((e) => e);
    expect(isShellError(err, 'PI_OFFLINE')).toBe(true);
  });

  it('SERVER_UNREACHABLE when the signaling server is down', async () => {
    const pi = new FakePi();
    const err = await pairAndSave(new MemoryStore(), { deviceId: pi.deviceId, secret: pi.secret, label: 'x', signalUrl: 'ws://x', env: makeEnv(pi, { unreachable: true }) }).catch((e) => e);
    expect(isShellError(err, 'SERVER_UNREACHABLE')).toBe(true);
  });
});

describe('session handshake (phone side)', () => {
  it('opens a channel after verifying the answer; closes the signaling socket', async () => {
    const pi = new FakePi();
    const { rec } = await paired(pi);
    const env = makeEnv(pi);
    const s = await openSession({ pi: rec, signalUrl: 'ws://x', iceServers: ['stun:example.org'], env });
    expect(s.channel.readyState).toBe('open');
    expect(FakeRTCPeerConnection.last?.config?.iceServers).toEqual([{ urls: 'stun:example.org' }]);
    expect((env.sockets.at(-1) as { readyState: number }).readyState).toBe(3);
  });

  it('rejects an answer the Pi did not sign for THIS fingerprint (BAD_ANSWER) and closes the peer', async () => {
    const pi = new FakePi();
    const { rec } = await paired(pi);
    pi.mode = 'bad-answer';
    const err = await openSession({ pi: rec, signalUrl: 'ws://x', iceServers: [], env: makeEnv(pi) }).catch((e) => e);
    expect(isShellError(err, 'BAD_ANSWER')).toBe(true);
    expect(FakeRTCPeerConnection.last?.closed).toBe(true);
    expect(FakeRTCPeerConnection.last?.remote).toBeUndefined(); // the answer was never applied
  });

  it('session.reject -> NOT_PAIRED; offline -> PI_OFFLINE; ICE never connects -> UNREACHABLE', async () => {
    const pi = new FakePi();
    const { rec } = await paired(pi);
    pi.mode = 'session-reject';
    expect(isShellError(await openSession({ pi: rec, signalUrl: 'ws://x', iceServers: [], env: makeEnv(pi) }).catch((e) => e), 'NOT_PAIRED')).toBe(true);
    pi.mode = 'normal';
    pi.online = false;
    expect(isShellError(await openSession({ pi: rec, signalUrl: 'ws://x', iceServers: [], env: makeEnv(pi) }).catch((e) => e), 'PI_OFFLINE')).toBe(true);
    pi.online = true;
    FakeRTCPeerConnection.neverConnect = true;
    try {
      expect(isShellError(await openSession({ pi: rec, signalUrl: 'ws://x', iceServers: [], env: makeEnv(pi), connectTimeoutMs: 50 }).catch((e) => e), 'UNREACHABLE')).toBe(true);
    } finally {
      FakeRTCPeerConnection.neverConnect = false;
    }
  });

  it('KEY_MISSING when the stored record has lost its key (no crash)', async () => {
    const pi = new FakePi();
    const { rec } = await paired(pi);
    const broken = { ...rec, keyPair: undefined } as unknown as PiRecord;
    expect(isShellError(await openSession({ pi: broken, signalUrl: 'ws://x', iceServers: [], env: makeEnv(pi) }).catch((e) => e), 'KEY_MISSING')).toBe(true);
  });
});

describe('first-use consent', () => {
  it('asks once per Pi + app + origin, and again if the origin changes', async () => {
    const store = new MemoryStore();
    const id = 'b'.repeat(52);
    expect(await needsConsent(store, id, 'files', 'https://files.example/app/')).toBe(true);
    await recordConsent(store, id, 'files', 'https://files.example/app/');
    expect(await needsConsent(store, id, 'files', 'https://files.example/other/path')).toBe(false);
    expect(await needsConsent(store, id, 'files', 'https://evil.example/app/')).toBe(true);
    expect(await needsConsent(store, id, 'notes', 'https://files.example/app/')).toBe(true);
    await store.deletePi(id);
    expect(await needsConsent(store, id, 'files', 'https://files.example/app/')).toBe(true);
  });
});
