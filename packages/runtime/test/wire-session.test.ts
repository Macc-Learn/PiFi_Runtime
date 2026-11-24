/** Phase 3 data channel: control ops, app requests, events, streams, limits, heartbeat. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeChunk, fingerprintBytes } from '@pifi/protocol';
import { NdcPeerTransport, shutdownPeerLibrary, type PiChannel } from '../src/peer.js';

after(() => shutdownPeerLibrary());
import { SessionManager } from '../src/sessions.js';
import { silentLogger } from '../src/logger.js';
import { sleep, startDaemon, waitFor } from './helpers.js';
import { fakeTransports, openSession, pair, TestPhone, type WireClient } from './phone-helpers.js';

async function setup(opts: Parameters<typeof startDaemon>[0] = {}) {
  const tr = fakeTransports();
  const t = await startDaemon({ apps: ['echo', 'mute'], transportFactory: tr.factory, ...opts });
  const phone = new TestPhone();
  await pair(t.daemon, phone);
  const { client } = await openSession(t.daemon, phone, tr);
  return { t, tr, phone, client };
}

test('control ops: status, apps.list, start/stop, unknown op, bad payload', async () => {
  const { t, client } = await setup();
  try {
    const status = await client.call('1', 'status');
    assert.equal(status.ok, true);
    assert.equal((status as { payload: { deviceId: string } }).payload.deviceId, t.daemon.identity.deviceId);
    const apps = (await client.call('2', 'apps.list')) as { payload: Array<{ name: string; frontend?: string; displayName?: string }> };
    const echo = apps.payload.find((a) => a.name === 'echo')!;
    assert.equal(echo.displayName, 'Echo');
    assert.match(echo.frontend ?? '', /^https:/);
    assert.deepEqual((await client.call('3', 'apps.start', { name: 'echo' })), { t: 'res', id: '3', ok: true, payload: { state: 'running' } });
    assert.equal(((await client.call('4', 'apps.start', { name: 'ghost' })) as { error: { code: string } }).error.code, 'NOT_FOUND');
    assert.equal(((await client.call('5', 'apps.start', {})) as { error: { code: string } }).error.code, 'BAD_REQUEST');
    assert.equal(((await client.call('6', 'reboot')) as { error: { code: string } }).error.code, 'NOT_FOUND');
    assert.deepEqual((await client.call('7', 'apps.stop', { name: 'echo' })).ok, true);
  } finally {
    await t.cleanup();
  }
});

test('app requests: routed as {op, payload}; not running; timeout cleans up', async () => {
  const { t, client } = await setup({ appRequestTimeoutMs: 300 });
  try {
    assert.equal(((await client.call('1', 'echo', 1, 'echo')) as { error: { code: string } }).error.code, 'APP_NOT_RUNNING');
    await client.call('2', 'apps.start', { name: 'echo' });
    assert.deepEqual(await client.call('3', 'echo', { hi: [1, 2] }, 'echo'), { t: 'res', id: '3', ok: true, payload: { hi: [1, 2] } });
    assert.equal(((await client.call('4', 'nope', {}, 'echo')) as { error: { code: string } }).error.code, 'NOT_FOUND', 'app error code passes through');
    await client.call('5', 'apps.start', { name: 'mute' });
    assert.equal(((await client.call('6', 'x', {}, 'mute')) as { error: { code: string } }).error.code, 'TIMEOUT');
    assert.equal(t.daemon.manager.records.get('mute')!.router.size, 0);
  } finally {
    await t.cleanup();
  }
});

test('events reach only subscribed sessions; unsub stops them', async () => {
  const { t, client } = await setup();
  try {
    await client.call('1', 'apps.start', { name: 'echo' });
    await client.call('2', 'count', { intervalMs: 50 }, 'echo');
    await sleep(200);
    assert.equal(client.frames.filter((f) => f.t === 'evt').length, 0, 'no events before sub');
    client.send({ t: 'sub', app: 'echo' });
    await client.waitFor((f) => f.t === 'evt' && f.app === 'echo' && f.name === 'count');
    client.send({ t: 'unsub', app: 'echo' });
    await sleep(100);
    const n = client.frames.filter((f) => f.t === 'evt').length;
    await sleep(250);
    assert.equal(client.frames.filter((f) => f.t === 'evt').length, n, 'no events after unsub');
    await client.call('3', 'stop', {}, 'echo');
  } finally {
    await t.cleanup();
  }
});

test('streams: open, chunk, half-close end, echo back; abort; odd sids only', async () => {
  const { t, client } = await setup();
  try {
    await client.call('1', 'apps.start', { name: 'echo' });
    client.send({ t: 's.open', sid: 1, app: 'echo', op: 'upload-echo', meta: { size: 40000 } });
    await client.waitFor((f) => f.t === 's.ok' && f.sid === 1);
    const data = new Uint8Array(40_000).map((_, i) => (i * 7) % 256);
    for (let o = 0; o < data.length; o += 16_384) client.ch.sendBinary(encodeChunk(1, data.subarray(o, o + 16_384)));
    client.send({ t: 's.end', sid: 1 });
    await client.waitFor((f) => f.t === 's.end' && f.sid === 1, 5000);
    assert.ok(Buffer.concat(client.chunks.get(1) ?? []).equals(Buffer.from(data)));

    client.send({ t: 's.open', sid: 2, app: 'echo', op: 'upload-echo' });
    assert.equal(((await client.waitFor((f) => f.t === 's.reject' && f.sid === 2)) as { error: { code: string } }).error.code, 'BAD_REQUEST');

    client.send({ t: 's.open', sid: 3, app: 'echo', op: 'upload-echo' });
    await client.waitFor((f) => f.t === 's.ok' && f.sid === 3);
    client.send({ t: 's.abort', sid: 3, reason: 'user cancelled' });
    await waitFor(() => t.daemon.manager.records.get('echo')!.streams!.size === 0, 2000, 'app side aborted');

    client.send({ t: 's.open', sid: 5, app: 'mute', op: 'x' });
    assert.ok(await client.waitFor((f) => f.t === 's.reject' && f.sid === 5), 'apps without streams reject');
  } finally {
    await t.cleanup();
  }
});

test('backpressure: a slow phone pauses the app socket until the channel drains', async () => {
  const { t, client } = await setup();
  try {
    await client.call('1', 'apps.start', { name: 'echo' });
    const piEnd = client.ch.peer!;
    piEnd.buffered = 2 * 1024 * 1024; // pretend the phone isn't reading
    client.send({ t: 's.open', sid: 1, app: 'echo', op: 'upload-echo' });
    await client.waitFor((f) => f.t === 's.ok');
    client.ch.sendBinary(encodeChunk(1, new Uint8Array(1000)));
    const rec = t.daemon.manager.records.get('echo')!;
    await waitFor(() => rec.ws?.isPaused === true, 2000, 'app paused');
    piEnd.drain();
    assert.equal(rec.ws?.isPaused, false, 'resumed on bufferedamountlow');
  } finally {
    await t.cleanup();
  }
});

async function expectClosed(client: WireClient, send: () => void): Promise<void> {
  send();
  await waitFor(() => client.ch.closed, 2000, 'session closed');
}

test('malformed frames, oversized frames, unexpected frames and floods close the session', async () => {
  const cases: Array<(c: WireClient) => void> = [
    (c) => c.ch.sendText('not json'),
    (c) => c.ch.sendText(JSON.stringify({ t: 'req', id: '1', op: 'status', payload: 'x'.repeat(70_000) })),
    (c) => c.ch.sendText(JSON.stringify({ t: 'res', id: '1', ok: true })),
    (c) => c.ch.sendBinary(new Uint8Array([0, 0])),
    (c) => { for (let i = 0; i < 400; i++) c.ch.sendText('{"t":"ping","n":1}'); },
  ];
  for (const make of cases) {
    const { t, client } = await setup();
    try {
      await expectClosed(client, () => make(client));
    } finally {
      await t.cleanup();
    }
  }
});

test('heartbeat: a silent session is closed after the idle time', async () => {
  const t = await startDaemon({ configOverrides: { sessionIdleSec: 1 }, transportFactory: fakeTransports().factory });
  const tr = fakeTransports();
  try {
    const phone = new TestPhone();
    await pair(t.daemon, phone);
    // Fresh manager with a short idle time, sharing the daemon's state.
    const sm = new SessionManager({
      identity: t.daemon.identity, paired: t.daemon.paired, manager: t.daemon.manager, transportFactory: tr.factory,
      iceServers: [], maxSessions: 5, idleMs: 200, log: silentLogger, status: async () => ({}),
    });
    const fakeDaemon = { identity: t.daemon.identity, handlePhoneBody: async (peer: string, body: Parameters<typeof t.daemon.handlePhoneBody>[1]) =>
      body.k === 'session.hello' ? sm.hello(peer, body.phoneId, body.np) : body.k === 'session.offer' ? sm.offer(peer, body.sdp, body.sig) : t.daemon.handlePhoneBody(peer, body) };
    const { client } = await openSession(fakeDaemon as never, phone, tr);
    for (let i = 0; i < 4; i++) { await sleep(100); client.send({ t: 'ping', n: i }); } // pings keep it alive
    assert.equal(client.ch.closed, false);
    await waitFor(() => client.ch.closed, 1000, 'idle close');
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// One test with the real node-datachannel (loopback, no STUN)
// ---------------------------------------------------------------------------

test('real node-datachannel: Pi transport answers a real offer, channel carries text and binary', async () => {
  const ndc = (await import('node-datachannel')).default;
  const phone = new ndc.PeerConnection('phone', { iceServers: [] });
  const pi = new NdcPeerTransport();
  try {
    const gathered = new Promise<void>((resolve) => phone.onGatheringStateChange((s) => { if (s === 'complete') resolve(); }));
    const dc = phone.createDataChannel('pifi');
    if (phone.gatheringState() !== 'complete') await gathered; // it can already be complete here
    const offer = phone.localDescription()!.sdp;
    assert.ok(fingerprintBytes(offer), 'real offer has a single sha-256 fingerprint');

    const opened = new Promise<PiChannel>((resolve) => pi.onChannelOpen(resolve));
    const { answerSdp } = await pi.acceptOffer(offer, []);
    assert.ok(fingerprintBytes(answerSdp), 'real answer has a usable fingerprint');
    assert.match(answerSdp, /a=candidate/, 'full SDP with candidates (no trickle)');
    phone.setRemoteDescription(answerSdp, 'answer');

    const piCh = await opened;
    const gotText = new Promise<string>((r) => piCh.onText(r));
    const gotBin = new Promise<Uint8Array>((r) => piCh.onBinary(r));
    await new Promise<void>((r) => (dc.isOpen() ? r() : dc.onOpen(() => r())));
    dc.sendMessage('{"t":"ping","n":1}');
    dc.sendMessageBinary(encodeChunk(1, new Uint8Array([9, 8, 7])));
    assert.equal(await gotText, '{"t":"ping","n":1}');
    assert.deepEqual(await gotBin, encodeChunk(1, new Uint8Array([9, 8, 7])));

    const echoed = new Promise<string>((r) => dc.onMessage((m) => r(String(m))));
    piCh.sendText('{"t":"pong","n":1}');
    assert.equal(await echoed, '{"t":"pong","n":1}');
  } finally {
    pi.close();
    phone.close();
  }
});
