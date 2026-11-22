/** Phase 2 §11 runtime tests: the Pi's signaling client against an in-process fake server. */
import { after, test } from 'node:test';
import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import { fromBase64url, randomNonce, registrationMessage, SignalCloseCode, toBase64url, verifyP1363 } from '@pifi/protocol';
import { Backoff, jitter, SignalingClient, type SignalingState } from '../src/signalingClient.js';
import { loadOrCreateIdentity, type Identity } from '../src/identity.js';
import { silentLogger } from '../src/logger.js';
import { adminHeaders, call, makeHome, sleep, startDaemon, waitFor } from './helpers.js';

// ---------------------------------------------------------------------------
// A fake signaling server that really checks the handshake, and can misbehave on demand
// ---------------------------------------------------------------------------

interface FakeServer {
  url: string;
  sockets: WebSocket[];
  registrations: number;
  /** What the server does right after a successful registration. */
  afterRegister?: (ws: WebSocket) => void;
  /** Make the next handshakes fail with 4010. */
  rejectAuth: boolean;
  received: Array<Record<string, unknown>>;
  latest(): WebSocket;
  close(): Promise<void>;
}

async function fakeServer(): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const fake: FakeServer = {
    url: `ws://127.0.0.1:${port}/ws`,
    sockets: [],
    registrations: 0,
    rejectAuth: false,
    received: [],
    latest: () => fake.sockets[fake.sockets.length - 1] as WebSocket,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
  wss.on('connection', (ws) => {
    fake.sockets.push(ws);
    let hello: { deviceId: string; publicKey: Buffer } | undefined;
    let nonce = '';
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, string>;
      fake.received.push(msg);
      if (msg.type === 'pi.hello') {
        hello = { deviceId: msg.deviceId as string, publicKey: fromBase64url(msg.publicKey as string) as Buffer };
        nonce = randomNonce();
        ws.send(JSON.stringify({ v: 1, type: 'challenge', nonce }));
      } else if (msg.type === 'pi.auth' && hello) {
        const ok = verifyP1363(hello.publicKey, registrationMessage(nonce, hello.deviceId), fromBase64url(msg.signature as string) as Buffer);
        if (!ok || fake.rejectAuth) return void ws.close(SignalCloseCode.REGISTRATION_FAILED, 'registration failed');
        fake.registrations++;
        ws.send(JSON.stringify({ v: 1, type: 'registered', deviceId: hello.deviceId }));
        fake.afterRegister?.(ws);
      }
    });
  });
  return fake;
}

const homes: string[] = [];
after(async () => { for (const h of homes) await rm(h, { recursive: true, force: true }); });

async function identity(): Promise<Identity> {
  const home = await makeHome();
  homes.push(home);
  return loadOrCreateIdentity(home, silentLogger);
}

function client(url: string | undefined, id: Identity, extra: Partial<ConstructorParameters<typeof SignalingClient>[0]> = {}): SignalingClient {
  return new SignalingClient({ url, identity: id, log: silentLogger, dev: false, pingMs: 25_000, backoffMinMs: 20, backoffMaxMs: 640, random: () => 0.5, ...extra });
}

function states(c: SignalingClient): SignalingState[] {
  const seen: SignalingState[] = [];
  c.on('state', (s: SignalingState) => seen.push(s));
  return seen;
}

// ---------------------------------------------------------------------------

test('client registers (real signature check) and reaches online', async () => {
  const srv = await fakeServer();
  const id = await identity();
  const c = client(srv.url, id);
  const seen = states(c);
  try {
    c.start();
    await waitFor(() => c.getState().state === 'online', 3000, 'online');
    assert.deepEqual(seen.map((s) => s.state), ['connecting', 'authenticating', 'online']);
    assert.equal(c.getState().url, srv.url);
    const hello = srv.received.find((m) => m.type === 'pi.hello');
    assert.equal(hello?.deviceId, id.deviceId);
  } finally {
    await c.stop();
    await srv.close();
  }
  assert.equal(c.getState().state, 'disabled', 'stop() leaves it disabled');
});

test('Backoff: doubles from min, caps at max, +/-20% jitter, resets', () => {
  const mid = new Backoff(1000, 30_000, () => 0.5); // 0.5 -> exactly 1.0x
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(() => mid.next()), [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  mid.reset();
  assert.equal(mid.next(), 1000);
  assert.equal(new Backoff(1000, 30_000, () => 0).next(), 800, '-20%');
  assert.equal(new Backoff(1000, 30_000, () => 1).next(), 1200, '+20%');
  assert.equal(jitter(30_000, () => 0.999999) <= 36_000, true);
  for (let i = 0; i < 200; i++) {
    const d = jitter(1000);
    assert.ok(d >= 800 && d <= 1200, `jitter out of range: ${d}`);
  }
});

test('backoff grows across failures and resets after 60 s of stability (fake clock)', async () => {
  const srv = await fakeServer();
  srv.afterRegister = (ws) => setTimeout(() => ws.close(1001, 'going away'), 10);
  let now = 1_000_000;
  const c = client(srv.url, await identity(), { now: () => now });
  const seen = states(c);
  try {
    c.start();
    await waitFor(() => seen.filter((s) => s.state === 'backoff').length >= 4, 5000, 'four reconnects');
    const delays = seen.filter((s) => s.state === 'backoff').map((s) => s.retryInMs);
    assert.deepEqual(delays.slice(0, 4), [20, 40, 80, 160], 'grows while connections are short-lived');

    // Now pretend the next connection stays up for 61 s before dropping.
    // (Measured from inside the hook: a connection already in flight may still use the old one.)
    let mark = -1;
    srv.afterRegister = (ws) => { if (mark < 0) mark = seen.length; setTimeout(() => { now += 61_000; ws.close(1001); }, 30); };
    await waitFor(() => mark >= 0 && seen.slice(mark).some((s) => s.state === 'backoff'), 5000, 'next backoff');
    const next = seen.slice(mark).find((s) => s.state === 'backoff');
    assert.equal(next?.retryInMs, 20, 'reset to the minimum after a stable connection');
  } finally {
    await c.stop();
    await srv.close();
  }
});

test('close 4100 (server restarting): reconnects after a short random 0-3 s delay, not the backoff', async () => {
  const srv = await fakeServer();
  const c = client(srv.url, await identity(), { backoffMinMs: 10_000, backoffMaxMs: 30_000, random: () => 0.1 });
  const seen = states(c);
  try {
    c.start();
    await waitFor(() => c.getState().state === 'online');
    srv.latest().close(SignalCloseCode.SERVER_RESTARTING, 'server restarting');
    await waitFor(() => c.getState().state === 'backoff');
    assert.equal(c.getState().retryInMs, 300, '0.1 * 3000 ms');
    await waitFor(() => srv.registrations === 2, 3000, 'reconnected');
    assert.ok(!seen.some((s) => (s.retryInMs ?? 0) >= 10_000));
  } finally {
    await c.stop();
    await srv.close();
  }
});

test('close 4011 (replaced): waits at least 30 s; gives up after repeated replacement', async () => {
  const srv = await fakeServer();
  const c = client(srv.url, await identity());
  try {
    c.start();
    await waitFor(() => c.getState().state === 'online');
    srv.latest().close(SignalCloseCode.REPLACED, 'replaced');
    await waitFor(() => c.getState().state === 'backoff');
    assert.ok((c.getState().retryInMs ?? 0) >= 30_000, `waited ${c.getState().retryInMs}`);
  } finally {
    await c.stop();
    await srv.close();
  }

  // Two copies of the same identity fighting: stop after a few replacements in a row.
  const srv2 = await fakeServer();
  srv2.afterRegister = (ws) => setTimeout(() => ws.close(SignalCloseCode.REPLACED, 'replaced'), 10);
  const c2 = client(srv2.url, await identity(), { replacedWaitMs: 10, maxReplacedInARow: 3 });
  try {
    c2.start();
    await waitFor(() => c2.getState().state === 'disabled' && srv2.registrations > 0, 5000, 'give up');
    assert.equal(srv2.registrations, 4, '3 retries after the first replacement, then stop');
    assert.match(c2.getState().lastError ?? '', /replaced/);
  } finally {
    await c2.stop();
    await srv2.close();
  }
});

test('close 4010 (registration failed): uses the max backoff', async () => {
  const srv = await fakeServer();
  srv.rejectAuth = true;
  const c = client(srv.url, await identity(), { backoffMinMs: 1000, backoffMaxMs: 5000, random: () => 0 });
  try {
    c.start();
    await waitFor(() => c.getState().state === 'backoff', 3000);
    assert.equal(c.getState().retryInMs, 4000, 'max (5000) with -20% jitter');
  } finally {
    await c.stop();
    await srv.close();
  }
});

test('dead server (no pongs) is detected by the client ping', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws', autoPong: false } as ConstructorParameters<typeof WebSocketServer>[0]);
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ws`;
  const c = client(url, await identity(), { pingMs: 50 });
  try {
    c.start();
    await waitFor(() => c.getState().state === 'backoff', 3000, 'terminated after missed pong');
  } finally {
    await c.stop();
    await new Promise<void>((r) => { for (const x of wss.clients) x.terminate(); wss.close(() => r()); });
  }
});

// ---------------------------------------------------------------------------
// Daemon integration
// ---------------------------------------------------------------------------

test('disabled when PIFI_SIGNAL_URL is unset; daemon starts normally; /status shows it', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    assert.equal(t.config.signalUrl, undefined);
    assert.equal(t.daemon.signalingState().state, 'disabled');
    const status = JSON.parse((await call(t.daemon.controlPort, { path: '/status', headers: await adminHeaders(t.home) })).body);
    assert.equal(status.signaling.state, 'disabled');
    assert.equal(status.deviceId, t.daemon.identity.deviceId);
    assert.equal((await t.daemon.manager.start('echo')).state, 'running');
  } finally {
    await t.cleanup();
  }
});

test('an unreachable signaling server does not stop the daemon or apps', async () => {
  const srv = await fakeServer();
  const deadUrl = srv.url;
  await srv.close(); // nothing listens there now
  const t = await startDaemon({ apps: ['echo'], configOverrides: { signalUrl: deadUrl, signalBackoffMinMs: 50, signalBackoffMaxMs: 200 } });
  try {
    await waitFor(() => t.daemon.signalingState().state === 'backoff', 3000);
    assert.equal((await t.daemon.manager.start('echo')).state, 'running');
    assert.deepEqual(((await t.daemon.manager.request('echo', 'still works')) as { echoed: string }).echoed, 'still works');
  } finally {
    await t.cleanup();
  }
});

test('GET /status shows the live signaling state', async () => {
  const srv = await fakeServer();
  const t = await startDaemon({ configOverrides: { signalUrl: srv.url } });
  try {
    await waitFor(() => t.daemon.signalingState().state === 'online', 3000);
    const status = JSON.parse((await call(t.daemon.controlPort, { path: '/status', headers: await adminHeaders(t.home) })).body);
    assert.equal(status.signaling.state, 'online');
    assert.equal(status.signaling.url, srv.url);
    assert.equal(typeof status.signaling.since, 'number');
  } finally {
    await t.cleanup();
    await srv.close();
  }
});

async function relayAndListen(dev: boolean, payloadJson: unknown): Promise<Record<string, unknown> | undefined> {
  const srv = await fakeServer();
  const t = await startDaemon({ configOverrides: { signalUrl: srv.url, dev } });
  try {
    await waitFor(() => t.daemon.signalingState().state === 'online', 3000);
    const before = srv.received.length;
    const peerId = 'ab'.repeat(16);
    srv.latest().send(JSON.stringify({ v: 1, type: 'relay', peerId, payload: toBase64url(Buffer.from(JSON.stringify(payloadJson))) }));
    await sleep(300);
    return srv.received.slice(before).find((m) => m.type === 'relay');
  } finally {
    await t.cleanup();
    await srv.close();
  }
}

test('dev echo answers only with PIFI_DEV=1, and only the echo kind', async () => {
  const reply = await relayAndListen(true, { kind: 'echo', data: { n: 42 } });
  assert.ok(reply, 'dev mode replies');
  assert.equal(reply.peerId, 'ab'.repeat(16));
  assert.deepEqual(JSON.parse((fromBase64url(reply.payload as string) as Buffer).toString()), { kind: 'echo-reply', data: { n: 42 } });

  assert.equal(await relayAndListen(false, { kind: 'echo', data: 1 }), undefined, 'production mode drops it');
  assert.equal(await relayAndListen(true, { kind: 'start-app', name: 'echo' }), undefined, 'anything else is dropped even in dev');
});
