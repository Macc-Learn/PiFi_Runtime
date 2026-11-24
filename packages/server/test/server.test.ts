/** Phase 2 §11 server tests, against a real in-process server over real sockets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalCloseCode } from '@pifi/protocol';
import { clientIp } from '../src/http.js';
import { maskIp } from '../src/logger.js';
import { TokenBucket } from '../src/rateLimit.js';
import { b64, makePi, registerPi, sleep, startServer, TestWs, waitFor } from './helpers.js';

const { REGISTRATION_FAILED, REPLACED, RATE_LIMITED, PROTOCOL_VIOLATION, SERVER_RESTARTING } = SignalCloseCode;

// ---------------------------------------------------------------------------
// Registration handshake
// ---------------------------------------------------------------------------

test('handshake success: Pi receives `registered` and is online', async () => {
  const s = await startServer();
  try {
    const pi = makePi();
    const { ws } = await registerPi(s.url, pi);
    assert.equal(await s.server.presence.isOnline(pi.deviceId), true);
    assert.equal(await s.server.presence.count(), 1);
    ws.close();
    await ws.closed;
    await waitFor(async () => !(await s.server.presence.isOnline(pi.deviceId)), 2000, 'offline after close');
  } finally {
    await s.stop();
  }
});

test('reject: deviceId does not match the public key', async () => {
  const s = await startServer();
  try {
    const pi = makePi();
    const other = makePi();
    const ws = await TestWs.connect(s.url);
    ws.send({ type: 'pi.hello', deviceId: other.deviceId, publicKey: pi.publicKey });
    assert.equal((await ws.closed).code, REGISTRATION_FAILED);

    const bad = await TestWs.connect(s.url);
    bad.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: b64('not a key') });
    assert.equal((await bad.closed).code, REGISTRATION_FAILED, 'garbage public key');
  } finally {
    await s.stop();
  }
});

test('reject: wrong signature, signature over another nonce, replayed pi.auth', async () => {
  const s = await startServer();
  try {
    const pi = makePi();

    // Signature over the wrong bytes.
    const a = await TestWs.connect(s.url);
    a.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    await a.next();
    a.send({ type: 'pi.auth', signature: pi.signRaw(Buffer.from('something else')) });
    assert.equal((await a.closed).code, REGISTRATION_FAILED);

    // Signature over a nonce that was issued to a DIFFERENT connection.
    const b = await TestWs.connect(s.url);
    const c = await TestWs.connect(s.url);
    b.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    c.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    const nonceB = (await b.next()).nonce as string;
    await c.next();
    c.send({ type: 'pi.auth', signature: pi.sign(nonceB) });
    assert.equal((await c.closed).code, REGISTRATION_FAILED);
    b.close();

    // Replay: a valid signature from an earlier, successful handshake, sent on a new connection.
    const first = await registerPi(s.url, pi);
    first.ws.close();
    await first.ws.closed;
    const replay = await TestWs.connect(s.url);
    replay.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    await replay.next(); // fresh challenge, which the old signature does not cover
    replay.send({ type: 'pi.auth', signature: first.signature });
    assert.equal((await replay.closed).code, REGISTRATION_FAILED);

    // pi.auth with no pi.hello at all is not a valid first message.
    const cold = await TestWs.connect(s.url);
    cold.send({ type: 'pi.auth', signature: first.signature });
    assert.equal((await cold.closed).code, PROTOCOL_VIOLATION);
  } finally {
    await s.stop();
  }
});

test('reject: no pi.auth within the auth timeout', async () => {
  const s = await startServer({ authTimeoutMs: 200 });
  try {
    const pi = makePi();
    const ws = await TestWs.connect(s.url);
    ws.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    await ws.next();
    const began = Date.now();
    assert.equal((await ws.closed).code, REGISTRATION_FAILED);
    assert.ok(Date.now() - began >= 150);
  } finally {
    await s.stop();
  }
});

test('reject: an expired challenge (answered after nonceTtl)', async () => {
  let now = 1_000_000;
  const { createSignalingServer } = await import('../src/server.js');
  const { loadServerConfig } = await import('../src/config.js');
  const server = createSignalingServer(loadServerConfig({}, { host: '127.0.0.1', port: 0, authTimeoutMs: 60_000 }), {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => now,
  });
  const port = await server.listen();
  try {
    const pi = makePi();
    const ws = await TestWs.connect(`ws://127.0.0.1:${port}/ws`);
    ws.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    const nonce = (await ws.next()).nonce as string;
    now += 31_000; // clock-free in production terms: the server only compares its own timestamps
    ws.send({ type: 'pi.auth', signature: pi.sign(nonce) });
    assert.equal((await ws.closed).code, REGISTRATION_FAILED);
  } finally {
    await server.shutdown();
  }
});

test('duplicate registration: old socket gets 4011, new one stays online through the old close', async () => {
  const s = await startServer();
  try {
    const pi = makePi();
    const old = await registerPi(s.url, pi);
    const fresh = await registerPi(s.url, pi);
    assert.equal((await old.ws.closed).code, REPLACED);
    await sleep(100); // let the old socket's close handler run
    assert.equal(await s.server.presence.isOnline(pi.deviceId), true, 'old close did not mark the Pi offline');

    // And traffic goes to the NEW connection.
    const phone = await TestWs.connect(s.url);
    phone.send({ type: 'relay', deviceId: pi.deviceId, payload: b64('hi') });
    const got = await fresh.ws.next();
    assert.equal(got.type, 'relay');
    assert.equal(got.payload, b64('hi'));
  } finally {
    await s.stop();
  }
});

// ---------------------------------------------------------------------------
// Presence queries and relay
// ---------------------------------------------------------------------------

test('query: online, offline (left), and never-seen deviceIds', async () => {
  const s = await startServer();
  try {
    const online = makePi();
    const left = makePi();
    await registerPi(s.url, online);
    const l = await registerPi(s.url, left);
    l.ws.close();
    await l.ws.closed;
    await waitFor(async () => !(await s.server.presence.isOnline(left.deviceId)));

    for (const [id, expected] of [[online.deviceId, true], [left.deviceId, false], [makePi().deviceId, false]] as const) {
      const phone = await TestWs.connect(s.url);
      phone.send({ type: 'query', deviceId: id });
      assert.deepEqual(await phone.next(), { v: 1, type: 'status', deviceId: id, online: expected });
      if (!expected) assert.equal((await phone.closed).code, 1000, 'offline target: reply, then close');
      phone.close();
    }
  } finally {
    await s.stop();
  }
});

test('relay: phone -> Pi, Pi -> phone, to an offline Pi, and after the phone left', async () => {
  const s = await startServer();
  try {
    const pi = makePi();
    const { ws: piWs } = await registerPi(s.url, pi);

    const phone = await TestWs.connect(s.url);
    phone.send({ type: 'relay', deviceId: pi.deviceId, payload: b64('offer') });
    const toPi = await piWs.next();
    assert.equal(toPi.type, 'relay');
    assert.equal(toPi.payload, b64('offer'));
    assert.match(toPi.peerId as string, /^[0-9a-f]{32}$/);

    piWs.send({ type: 'relay', peerId: toPi.peerId as string, payload: b64('answer') });
    assert.deepEqual(await phone.next(), { v: 1, type: 'relay', deviceId: pi.deviceId, payload: b64('answer') });

    // A connection is bound to its first target.
    phone.send({ type: 'query', deviceId: makePi().deviceId });
    assert.equal((await phone.next()).code, 'target-mismatch');

    const lonely = await TestWs.connect(s.url);
    lonely.send({ type: 'relay', deviceId: makePi().deviceId, payload: b64('x') });
    assert.equal((await lonely.next()).code, 'target-offline');

    phone.close();
    await phone.closed;
    await sleep(50);
    piWs.send({ type: 'relay', peerId: toPi.peerId as string, payload: b64('late') });
    assert.equal((await piWs.next()).code, 'peer-gone');

    // A Pi cannot reach a phone that is talking to a different Pi.
    const other = makePi();
    const { ws: otherWs } = await registerPi(s.url, other);
    const phone2 = await TestWs.connect(s.url);
    phone2.send({ type: 'relay', deviceId: pi.deviceId, payload: b64('to first pi') });
    const peerId = (await piWs.next()).peerId as string;
    otherWs.send({ type: 'relay', peerId, payload: b64('hijack') });
    assert.equal((await otherWs.next()).code, 'peer-gone');
    assert.equal(await phone2.silentFor(150), true);
  } finally {
    await s.stop();
  }
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('oversized frame rejected; invalid JSON / schema -> 4013; role switching -> 4013; big payload -> error', async () => {
  const s = await startServer();
  try {
    const big = await TestWs.connect(s.url);
    big.sendRaw('x'.repeat(17 * 1024));
    assert.equal((await big.closed).code, 1009, 'ws closes oversized frames with 1009 (message too big)');

    for (const raw of ['not json', JSON.stringify({ v: 1, type: 'nope' }), JSON.stringify({ v: 1, type: 'query', deviceId: 'short' })]) {
      const ws = await TestWs.connect(s.url);
      ws.sendRaw(raw);
      assert.equal((await ws.closed).code, PROTOCOL_VIOLATION, raw);
    }
    const bin = await TestWs.connect(s.url);
    bin.sendRaw(Buffer.from([1, 2, 3]));
    assert.equal((await bin.closed).code, PROTOCOL_VIOLATION, 'binary frame');

    // phone -> pi.hello (the phone targets an ONLINE Pi, so it is allowed to stay)
    const pi = makePi();
    const { ws: piWs } = await registerPi(s.url, pi);
    const phone = await TestWs.connect(s.url);
    phone.send({ type: 'query', deviceId: pi.deviceId });
    await phone.next();
    phone.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    assert.equal((await phone.closed).code, PROTOCOL_VIOLATION);

    // pi -> query
    piWs.send({ type: 'query', deviceId: pi.deviceId });
    assert.equal((await piWs.closed).code, PROTOCOL_VIOLATION);
    await registerPi(s.url, pi); // back online for the payload check below

    // A payload that fits in the frame but exceeds the relay limit gets an error, not a hang-up.
    const p = await TestWs.connect(s.url);
    p.send({ type: 'relay', deviceId: pi.deviceId, payload: 'a'.repeat(15 * 1024 + 1) });
    assert.equal((await p.next()).code, 'payload-too-large');
  } finally {
    await s.stop();
  }
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

test('rate limit: new connections per IP -> 4012', async () => {
  const s = await startServer({ connectionsPerMinute: 3 });
  try {
    for (let i = 0; i < 3; i++) await TestWs.connect(s.url);
    const fourth = await TestWs.connect(s.url);
    assert.equal((await fourth.closed).code, RATE_LIMITED);
  } finally {
    await s.stop();
  }
});

test('rate limit: messages per connection -> 4012', async () => {
  const s = await startServer({ messageBurst: 3, messagesPerSecond: 1 });
  try {
    const pi = makePi();
    await registerPi(s.url, pi);
    const ws = await TestWs.connect(s.url);
    for (let i = 0; i < 6; i++) ws.send({ type: 'query', deviceId: pi.deviceId });
    assert.equal((await ws.closed).code, RATE_LIMITED);
  } finally {
    await s.stop();
  }
});

test('rate limit: repeated registration failures block the IP', async () => {
  const s = await startServer({ registrationFailuresPerMinute: 2 });
  try {
    const pi = makePi();
    for (let i = 0; i < 2; i++) {
      const ws = await TestWs.connect(s.url);
      ws.send({ type: 'pi.hello', deviceId: makePi().deviceId, publicKey: pi.publicKey });
      assert.equal((await ws.closed).code, REGISTRATION_FAILED);
    }
    const ws = await TestWs.connect(s.url);
    ws.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey }); // even a valid one
    assert.equal((await ws.closed).code, RATE_LIMITED);
  } finally {
    await s.stop();
  }
});

test('rate limit: MAX_PHONES_PER_IP', async () => {
  const s = await startServer({ maxPhonesPerIp: 2 });
  try {
    const target = makePi();
    await registerPi(s.url, target); // phones only stay connected while their Pi is online
    const id = target.deviceId;
    const phones = await Promise.all([0, 1].map(() => TestWs.connect(s.url)));
    for (const p of phones) { p.send({ type: 'query', deviceId: id }); await p.next(); }
    const third = await TestWs.connect(s.url);
    third.send({ type: 'query', deviceId: id });
    assert.equal((await third.closed).code, RATE_LIMITED);
    phones[0]!.close();
    await phones[0]!.closed;
    await sleep(50);
    const again = await TestWs.connect(s.url);
    again.send({ type: 'query', deviceId: id });
    assert.equal((await again.next()).type, 'status', 'slot freed when a phone leaves');
  } finally {
    await s.stop();
  }
});

test('TokenBucket: burst, then sustained rate', () => {
  let t = 0;
  const b = new TokenBucket(3, 2, () => t);
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
  t += 500; // +1 token at 2/s
  assert.deepEqual([b.take(), b.take()], [true, false]);
});

// ---------------------------------------------------------------------------
// Keepalive, shutdown, HTTP
// ---------------------------------------------------------------------------

test('ping timeout terminates a dead connection and marks the Pi offline', async () => {
  const s = await startServer({ pingIntervalMs: 100 });
  try {
    const pi = makePi();
    const { ws } = await registerPi(s.url, pi, { autoPong: false }); // a client that never answers pings
    assert.equal(await s.server.presence.isOnline(pi.deviceId), true);
    const { code } = await ws.closed;
    assert.equal(code, 1006, 'terminated, not closed politely');
    await waitFor(async () => !(await s.server.presence.isOnline(pi.deviceId)), 2000, 'offline');
  } finally {
    await s.stop();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

test('SIGTERM: every socket gets 4100, then the process exits 0', { skip: process.platform === 'win32' }, async () => {
  const port = await freePort();
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH ?? '', PORT: String(port), HOST: '127.0.0.1' } });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await waitFor(() => out.includes('listening'), 5000, 'server start');

  const url = `ws://127.0.0.1:${port}/ws`;
  const { ws: piWs } = await registerPi(url, makePi());
  const phone = await TestWs.connect(url);
  child.kill('SIGTERM');
  assert.equal((await piWs.closed).code, SERVER_RESTARTING);
  assert.equal((await phone.closed).code, SERVER_RESTARTING);
  assert.equal(await exited, 0);
});

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

test('HTTP: /healthz is 200 ok, everything else 404, WebSocket only on /ws', async () => {
  const s = await startServer();
  try {
    assert.deepEqual(await get(s.server.port, '/healthz'), { status: 200, body: 'ok' });
    assert.equal((await get(s.server.port, '/')).status, 404);
    assert.equal((await get(s.server.port, '/pis')).status, 404, 'no endpoint lists Pis');
    await assert.rejects(TestWs.connect(`ws://127.0.0.1:${s.server.port}/other`), /404/);
  } finally {
    await s.stop();
  }
});

test('client IP: socket address by default, LAST X-Forwarded-For entry with TRUST_PROXY', () => {
  const req = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } } as unknown as http.IncomingMessage;
  assert.equal(clientIp(req, false), '10.0.0.1');
  assert.equal(clientIp(req, true), '203.0.113.9');
  assert.equal(maskIp('203.0.113.9'), '203.0.x.x');
  assert.equal(maskIp('::ffff:127.0.0.1'), '127.0.x.x');
  assert.equal(maskIp('2001:db8:1:2::5'), '2001:db8:…');
});

// ---------------------------------------------------------------------------
// Privacy of logs
// ---------------------------------------------------------------------------

test('logs contain no payloads, signatures, nonces, keys, full deviceIds or full IPs', async () => {
  const s = await startServer();
  const pi = makePi();
  const secretPayload = b64('top-secret-payload-content');
  let nonce = '';
  let signature = '';
  try {
    const reg = await registerPi(s.url, pi);
    nonce = reg.nonce;
    signature = reg.signature;
    const phone = await TestWs.connect(s.url);
    phone.send({ type: 'relay', deviceId: pi.deviceId, payload: secretPayload });
    const got = await reg.ws.next();
    reg.ws.send({ type: 'relay', peerId: got.peerId as string, payload: secretPayload });
    await phone.next();
    // and some failures, which log too
    const bad = await TestWs.connect(s.url);
    bad.send({ type: 'pi.hello', deviceId: makePi().deviceId, publicKey: pi.publicKey });
    await bad.closed;
    reg.ws.close();
    await reg.ws.closed;
    await sleep(50);
  } finally {
    await s.stop();
  }
  const all = s.lines.join('\n');
  assert.ok(s.lines.length > 3, 'something was logged');
  for (const [what, needle] of [['payload', secretPayload], ['nonce', nonce], ['signature', signature], ['public key', pi.publicKey], ['full deviceId', pi.deviceId], ['full IP', '127.0.0.1']] as const) {
    assert.ok(!all.includes(needle), `logs must not contain the ${what}`);
  }
  assert.ok(all.includes(pi.deviceId.slice(0, 8)), 'short deviceId is logged');
});
