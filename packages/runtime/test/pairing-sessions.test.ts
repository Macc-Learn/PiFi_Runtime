/** Phase 3 Pi side: pairing and the session handshake (FakePeerTransport, real crypto). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  b64urlDecode, b64urlEncode, fingerprintBytes, SESSION_PHONE_CONTEXT, signedMessage, utf8, pairProof,
} from '@pifi/protocol';
import { FakePeerTransport } from '../src/peer.js';
import { PairingManager } from '../src/pairing.js';
import { SessionManager } from '../src/sessions.js';
import { silentLogger } from '../src/logger.js';
import { adminHeaders, call, memoryLogger, runCli, sleep, startDaemon, waitFor } from './helpers.js';
import { fakeTransports, offerSdp, openSession, pair, TestPhone } from './phone-helpers.js';

const REJECT = { k: 'pair.reject', reason: 'rejected' };

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

test('pairing: success, Pi proves itself over the phone challenge, code is single use', async () => {
  const t = await startDaemon();
  try {
    const { daemon } = t;
    const phone = new TestPhone();
    const code = daemon.pairing.create(60);
    const { body, challenge } = phone.pairRequest(daemon.identity.deviceId, code.secret, 'Alice phone');
    const reply = await daemon.handlePhoneBody('p'.repeat(32), body);
    assert.equal(reply.k, 'pair.accept');
    assert.equal(TestPhone.acceptIsValid(reply, daemon.identity.deviceId, phone.spki, challenge), true);
    // An old accept can't be replayed against a new challenge.
    assert.equal(TestPhone.acceptIsValid(reply, daemon.identity.deviceId, phone.spki, new Uint8Array(randomBytes(16))), false);

    assert.equal(daemon.paired.get(phone.phoneId)?.label, 'Alice phone');
    assert.equal(daemon.pairing.status().active, false, 'code burned');
    assert.deepEqual(await daemon.handlePhoneBody('p'.repeat(32), body), REJECT, 'same code cannot be used again');

    // A second phone needs a new code.
    const other = new TestPhone();
    assert.deepEqual(await daemon.handlePhoneBody('q'.repeat(32), other.pairRequest(daemon.identity.deviceId, code.secret).body), REJECT);
    assert.equal((await pair(daemon, other)).k, 'pair.accept');
    assert.equal(daemon.paired.size, 2);
  } finally {
    await t.cleanup();
  }
});

test('pairing failures all return the identical reject body', async () => {
  const t = await startDaemon({ configOverrides: { maxPairedPhones: 1 } });
  try {
    const { daemon } = t;
    const id = daemon.identity.deviceId;
    const phone = new TestPhone();
    const replies = [];
    // no active code
    replies.push(await daemon.handlePhoneBody('x'.repeat(32), phone.pairRequest(id, b64urlEncode(new Uint8Array(16))).body));
    // wrong proof
    daemon.pairing.create(60);
    replies.push(await daemon.handlePhoneBody('x'.repeat(32), phone.pairRequest(id, b64urlEncode(new Uint8Array(16))).body));
    // bad SPKI
    const code = daemon.pairing.create(60);
    const bad = phone.pairRequest(id, code.secret).body;
    replies.push(await daemon.handlePhoneBody('x'.repeat(32), { ...bad, phoneSpki: b64urlEncode(new Uint8Array(91)) }));
    // store full
    assert.equal((await pair(daemon, phone)).k, 'pair.accept');
    replies.push(await pair(daemon, new TestPhone()));
    for (const r of replies) assert.deepEqual(r, REJECT);
  } finally {
    await t.cleanup();
  }
});

test('pairing: 5 failed proofs revoke the code; expired codes are rejected (injected clock)', () => {
  let now = 0;
  const pm = new PairingManager({ now: () => now });
  const phone = new TestPhone();
  const deviceId = 'z'.repeat(52);
  const code = pm.create(60);
  for (let i = 0; i < 5; i++) assert.equal(pm.verifyProof(deviceId, phone.spki, new Uint8Array(32)), false);
  assert.equal(pm.status().active, false, 'burned after 5 failures');
  assert.equal(pm.verifyProof(deviceId, phone.spki, pairProof(code.secret, deviceId, phone.spki)), false, 'even the right proof fails now');

  const fresh = pm.create(60);
  now += 61_000;
  assert.equal(pm.verifyProof(deviceId, phone.spki, pairProof(fresh.secret, deviceId, phone.spki)), false, 'expired');
});

test('paired.json is 0600, written atomically, and has no secrets', { skip: process.platform === 'win32' }, async () => {
  const mem = memoryLogger();
  const t = await startDaemon({ log: mem.log });
  try {
    const phone = new TestPhone();
    const code = t.daemon.pairing.create(60);
    const { body } = phone.pairRequest(t.daemon.identity.deviceId, code.secret);
    await t.daemon.handlePhoneBody('p'.repeat(32), body);
    await t.daemon.paired.flush();
    const file = path.join(t.home, 'paired.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.v, 1);
    assert.equal(saved.phones[0].phoneId, phone.phoneId);
    assert.ok(!(await readFile(file, 'utf8')).includes(code.secret));
    assert.deepEqual((await readdir(t.home)).filter((f) => f.endsWith('.tmp')), []);
    const logs = mem.lines.join('\n');
    for (const needle of [code.secret, body.proof, body.phoneSpki, phone.phoneId]) assert.ok(!logs.includes(needle), 'logs leak');
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Session handshake
// ---------------------------------------------------------------------------

test('session: good handshake opens a data channel and marks lastSeenAt', async () => {
  const tr = fakeTransports();
  const t = await startDaemon({ transportFactory: tr.factory });
  try {
    const phone = new TestPhone();
    await pair(t.daemon, phone);
    const before = t.daemon.paired.get(phone.phoneId)!.lastSeenAt;
    await sleep(5);
    const { client } = await openSession(t.daemon, phone, tr);
    client.send({ t: 'ping', n: 7 });
    assert.deepEqual(await client.waitFor((f) => f.t === 'pong'), { t: 'pong', n: 7 });
    assert.equal(t.daemon.sessions.count, 1);
    assert.ok(t.daemon.paired.get(phone.phoneId)!.lastSeenAt > before);
  } finally {
    await t.cleanup();
  }
});

test('session: unknown phone still gets a challenge, then a reject; no WebRTC work before auth', async () => {
  const tr = fakeTransports();
  const t = await startDaemon({ transportFactory: tr.factory });
  try {
    const stranger = new TestPhone();
    const before = FakePeerTransport.created;
    const np = b64urlEncode(new Uint8Array(randomBytes(16)));
    const ch = await t.daemon.handlePhoneBody('s'.repeat(32), { k: 'session.hello', phoneId: stranger.phoneId, np });
    assert.equal(ch.k, 'session.challenge', 'no paired-ness oracle');
    const nc = b64urlDecode((ch as { nc: string }).nc)!;
    const sdp = offerSdp();
    const sig = stranger.sign(signedMessage(SESSION_PHONE_CONTEXT, utf8(t.daemon.identity.deviceId), utf8(stranger.phoneId), b64urlDecode(np)!, nc, fingerprintBytes(sdp)!));
    assert.deepEqual(await t.daemon.handlePhoneBody('s'.repeat(32), { k: 'session.offer', sdp, sig }), { k: 'session.reject', reason: 'rejected' });
    assert.equal(FakePeerTransport.created, before);
  } finally {
    await t.cleanup();
  }
});

async function offerWith(t: Awaited<ReturnType<typeof startDaemon>>, phone: TestPhone, peerId: string, tweak: { sdp?: string; badSig?: boolean; reuse?: boolean } = {}) {
  const np = new Uint8Array(randomBytes(16));
  const ch = await t.daemon.handlePhoneBody(peerId, { k: 'session.hello', phoneId: phone.phoneId, np: b64urlEncode(np) });
  const nc = b64urlDecode((ch as { nc: string }).nc)!;
  const sdp = tweak.sdp ?? offerSdp();
  const fp = fingerprintBytes(sdp) ?? new Uint8Array(32);
  const signedOver = signedMessage(SESSION_PHONE_CONTEXT, utf8(t.daemon.identity.deviceId), utf8(phone.phoneId), np, nc, tweak.badSig ? new Uint8Array(32) : fp);
  const offer = { k: 'session.offer' as const, sdp, sig: phone.sign(signedOver) };
  const first = await t.daemon.handlePhoneBody(peerId, offer);
  return tweak.reuse ? t.daemon.handlePhoneBody(peerId, offer) : first;
}

test('session: wrong signature, bad fingerprints and reused challenges are rejected before WebRTC', async () => {
  const tr = fakeTransports();
  const t = await startDaemon({ transportFactory: tr.factory });
  try {
    const phone = new TestPhone();
    await pair(t.daemon, phone);
    const before = FakePeerTransport.created;
    assert.equal((await offerWith(t, phone, 'a'.repeat(32), { badSig: true })).k, 'session.reject');
    assert.equal((await offerWith(t, phone, 'b'.repeat(32), { sdp: 'v=0\r\na=fingerprint:sha-1 ' + 'AB:'.repeat(19) + 'AB\r\n' })).k, 'session.reject');
    assert.equal((await offerWith(t, phone, 'c'.repeat(32), { sdp: 'v=0\r\nno fingerprint here\r\n' })).k, 'session.reject');
    assert.equal(FakePeerTransport.created, before, 'no peer connection for any of these');
    // A valid offer works once; replaying it (challenge already consumed) does not.
    assert.equal((await offerWith(t, phone, 'd'.repeat(32), { reuse: true })).k, 'session.reject');
    assert.equal(FakePeerTransport.created, before + 1, 'only the first, valid offer created a transport');
  } finally {
    await t.cleanup();
  }
});

test('session: expired challenge (injected clock) and per-peer rate limit', async () => {
  const t = await startDaemon();
  try {
    let now = 1_000_000;
    const phone = new TestPhone();
    await pair(t.daemon, phone);
    const sm = new SessionManager({
      identity: t.daemon.identity, paired: t.daemon.paired, manager: t.daemon.manager, transportFactory: () => new FakePeerTransport(),
      iceServers: [], maxSessions: 5, idleMs: 60_000, log: silentLogger, status: async () => ({}), now: () => now,
    });
    const np = new Uint8Array(randomBytes(16));
    const ch = sm.hello('e'.repeat(32), phone.phoneId, b64urlEncode(np));
    const nc = b64urlDecode((ch as { nc: string }).nc)!;
    const sdp = offerSdp();
    const sig = phone.sign(signedMessage(SESSION_PHONE_CONTEXT, utf8(t.daemon.identity.deviceId), utf8(phone.phoneId), np, nc, fingerprintBytes(sdp)!));
    now += 31_000;
    assert.equal((await sm.offer('e'.repeat(32), sdp, sig)).k, 'session.reject', 'challenge older than 30 s');

    const replies = Array.from({ length: 6 }, () => sm.hello('r'.repeat(32), phone.phoneId, b64urlEncode(np)).k);
    assert.deepEqual(replies, ['session.challenge', 'session.challenge', 'session.challenge', 'session.challenge', 'session.challenge', 'session.reject'],
      '5 attempts per minute per peer (the expired one above was on another peer)');
    now += 61_000;
    assert.equal(sm.hello('r'.repeat(32), phone.phoneId, b64urlEncode(np)).k, 'session.challenge', 'limit resets after a minute');
  } finally {
    await t.cleanup();
  }
});

test('session: cap on concurrent sessions; a new session for the same phone replaces the old', async () => {
  const tr = fakeTransports();
  const t = await startDaemon({ transportFactory: tr.factory, configOverrides: { maxSessions: 1 } });
  try {
    const a = new TestPhone();
    const b = new TestPhone();
    await pair(t.daemon, a);
    await pair(t.daemon, b);
    const first = await openSession(t.daemon, a, tr, '1'.repeat(32));
    assert.equal((await offerWith(t, b, '2'.repeat(32))).k, 'session.reject', 'cap reached');
    const second = await openSession(t.daemon, a, tr, '3'.repeat(32));
    await waitFor(() => first.client.ch.closed, 1000, 'old session closed');
    second.client.send({ t: 'ping', n: 1 });
    await second.client.waitFor((f) => f.t === 'pong');
    assert.equal(t.daemon.sessions.count, 1);
  } finally {
    await t.cleanup();
  }
});

test('revoke closes the live session immediately and blocks new sessions (API, CLI and control op)', async () => {
  const tr = fakeTransports();
  const t = await startDaemon({ transportFactory: tr.factory });
  try {
    const a = new TestPhone();
    const b = new TestPhone();
    const c = new TestPhone();
    await pair(t.daemon, a, undefined, 'phone-a');
    await pair(t.daemon, b, undefined, 'phone-b');
    await pair(t.daemon, c, undefined, 'phone-c');

    // 1. Control API, by prefix.
    const sa = await openSession(t.daemon, a, tr, '1'.repeat(32));
    const headers = await adminHeaders(t.home);
    const list = JSON.parse((await call(t.daemon.controlPort, { path: '/phones', headers })).body);
    assert.equal(list.find((p: { phoneId: string }) => p.phoneId === a.phoneId).connected, true);
    assert.ok(!JSON.stringify(list).includes('spki'), 'no keys in GET /phones');
    assert.equal((await call(t.daemon.controlPort, { method: 'DELETE', path: '/phones/abc', headers })).status, 404, 'prefix too short');
    const del = await call(t.daemon.controlPort, { method: 'DELETE', path: `/phones/${a.phoneId.slice(0, 8)}`, headers });
    assert.equal(del.status, 200);
    await waitFor(() => sa.client.ch.closed, 1000, 'session closed by revoke');
    assert.equal((await offerWith(t, a, '4'.repeat(32))).k, 'session.reject', 'revoked phone cannot reconnect');

    // 2. Control op from another phone.
    const sb = await openSession(t.daemon, b, tr, '5'.repeat(32));
    const sc = await openSession(t.daemon, c, tr, '6'.repeat(32));
    const phones = await sb.client.call('1', 'phones.list');
    assert.equal((phones as { payload: Array<{ current?: boolean; phoneId: string }> }).payload.find((p) => p.phoneId === b.phoneId)?.current, true);
    assert.equal((await sb.client.call('2', 'phones.revoke', { phoneId: c.phoneId })).ok, true);
    await waitFor(() => sc.client.ch.closed, 1000, 'other phone kicked');

    // 3. Revoking yourself: reply first, then the session closes.
    const self = await sb.client.call('3', 'phones.revoke', { phoneId: b.phoneId });
    assert.equal(self.ok, true);
    await waitFor(() => sb.client.ch.closed, 1000, 'own session closed after reply');

    // 4. CLI, by label, and `devices list`.
    const d = new TestPhone();
    await pair(t.daemon, d, undefined, 'kitchen tablet');
    const env = { PIFI_HOME: t.home, PIFI_CONTROL_PORT: String(t.daemon.controlPort) };
    const listed = await runCli(['devices', 'list', '--json'], env);
    assert.equal(JSON.parse(listed.stdout).length, 1);
    const revoked = await runCli(['devices', 'revoke', 'kitchen tablet'], env);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.equal(t.daemon.paired.size, 0);

    const status = JSON.parse((await call(t.daemon.controlPort, { path: '/status', headers })).body);
    assert.equal(status.paired, 0);
    assert.equal(typeof status.sessions, 'number');
  } finally {
    await t.cleanup();
  }
});
