/** Phase 3 Part A: signaling server hardening. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalCloseCode } from '@pifi/protocol';
import { ipKey } from '../src/ipKey.js';
import { IpRateLimiter } from '../src/rateLimit.js';
import { b64, makePi, registerPi, sleep, startServer, TestWs, waitFor } from './helpers.js';

test('first-message timeout: a silent connection is closed with 4013', async () => {
  const s = await startServer({ firstMessageTimeoutMs: 150 });
  try {
    const ws = await TestWs.connect(s.url);
    const began = Date.now();
    assert.equal((await ws.closed).code, SignalCloseCode.PROTOCOL_VIOLATION);
    assert.ok(Date.now() - began >= 100);
    // A connection that does identify itself in time is not affected.
    const pi = makePi();
    const { ws: piWs } = await registerPi(s.url, pi);
    await sleep(300);
    assert.equal(await s.server.presence.isOnline(pi.deviceId), true);
    piWs.close();
  } finally {
    await s.stop();
  }
});

test('phone whose first query targets an offline Pi gets the reply, then a 1000 close', async () => {
  const s = await startServer();
  try {
    const id = makePi().deviceId;
    const q = await TestWs.connect(s.url);
    q.send({ type: 'query', deviceId: id });
    assert.deepEqual(await q.next(), { v: 1, type: 'status', deviceId: id, online: false });
    assert.equal((await q.closed).code, 1000);

    const r = await TestWs.connect(s.url);
    r.send({ type: 'relay', deviceId: id, payload: b64('hi') });
    assert.equal((await r.next()).code, 'target-offline');
    assert.equal((await r.closed).code, 1000);

    // Online target: the phone stays.
    const pi = makePi();
    await registerPi(s.url, pi);
    const ok = await TestWs.connect(s.url);
    ok.send({ type: 'query', deviceId: pi.deviceId });
    assert.equal((await ok.next()).online, true);
    assert.equal(await ok.silentFor(200), true);
    assert.equal(s.server.hub.phoneConnections, 1);
  } finally {
    await s.stop();
  }
});

test('phone idle timeout closes a phone that stops talking', async () => {
  const s = await startServer({ phoneIdleTimeoutMs: 200 });
  try {
    const pi = makePi();
    await registerPi(s.url, pi);
    const phone = await TestWs.connect(s.url);
    phone.send({ type: 'query', deviceId: pi.deviceId });
    await phone.next();
    await sleep(120);
    phone.send({ type: 'query', deviceId: pi.deviceId }); // activity resets the timer
    await phone.next();
    const began = Date.now();
    assert.equal((await phone.closed).code, 1000);
    assert.ok(Date.now() - began >= 150, 'timer was reset by the second message');
  } finally {
    await s.stop();
  }
});

test('global caps: total connections refused with 503; phone cap protects Pi slots', async () => {
  const s = await startServer({ maxConnections: 4, maxPhoneConnections: 2, maxPhonesPerIp: 10, connectionsPerMinute: 100 });
  try {
    const pi = makePi();
    await registerPi(s.url, pi); // 1 slot
    const phones: TestWs[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await TestWs.connect(s.url);
      p.send({ type: 'query', deviceId: pi.deviceId });
      await p.next();
      phones.push(p);
    } // 3 slots
    const extraPhone = await TestWs.connect(s.url); // 4th socket is allowed in...
    extraPhone.send({ type: 'query', deviceId: pi.deviceId });
    assert.equal((await extraPhone.closed).code, SignalCloseCode.RATE_LIMITED, '...but cannot become a 3rd phone');

    // A second Pi still gets in, because phones can't take the remaining slots.
    const pi2 = makePi();
    await registerPi(s.url, pi2);
    assert.equal(await s.server.presence.isOnline(pi2.deviceId), true);

    // Now all 4 slots are used: the next upgrade is refused before it becomes a WebSocket.
    await assert.rejects(TestWs.connect(s.url), /503/);
  } finally {
    await s.stop();
  }
});

test('MAX_PIS_PER_IP caps Pi connections from one address', async () => {
  const s = await startServer({ maxPisPerIp: 2 });
  try {
    await registerPi(s.url, makePi());
    await registerPi(s.url, makePi());
    const third = await TestWs.connect(s.url);
    const pi = makePi();
    third.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    assert.equal((await third.closed).code, SignalCloseCode.RATE_LIMITED);
    await sleep(50);
    // A rejected attempt must not leave a ghost count behind: after one Pi leaves, a new one fits.
    const fourth = await TestWs.connect(s.url);
    fourth.send({ type: 'pi.hello', deviceId: pi.deviceId, publicKey: pi.publicKey });
    assert.equal((await fourth.closed).code, SignalCloseCode.RATE_LIMITED, 'still 2 live Pis');
  } finally {
    await s.stop();
  }
});

test('MAX_PIS_PER_IP frees the slot when a Pi disconnects', async () => {
  const s = await startServer({ maxPisPerIp: 1 });
  try {
    const first = await registerPi(s.url, makePi());
    first.ws.close();
    await first.ws.closed;
    await sleep(50);
    const pi = makePi();
    await registerPi(s.url, pi);
    await waitFor(async () => s.server.presence.isOnline(pi.deviceId));
  } finally {
    await s.stop();
  }
});

test('ipKey: IPv4 per address, IPv6 per /64, IPv4-mapped IPv6 as IPv4', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:1:2::5'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('2001:db8:1:2::5'), ipKey('2001:db8:1:2:ffff::9'), 'same /64 shares a limit');
  assert.notEqual(ipKey('2001:db8:1:2::5'), ipKey('2001:db8:1:3::5'));
});

test('rate limiter groups IPv6 addresses by /64', () => {
  const lim = new IpRateLimiter({ connectionsPerMinute: 2, registrationFailuresPerMinute: 2, registrationBlockMs: 60_000 });
  assert.equal(lim.allowConnection('2001:db8:1:2::1'), true);
  assert.equal(lim.allowConnection('2001:db8:1:2::2'), true);
  assert.equal(lim.allowConnection('2001:db8:1:2::3'), false, 'third address in the same /64 is over the limit');
  assert.equal(lim.allowConnection('2001:db8:1:9::1'), true, 'another /64 is separate');
  lim.recordRegistrationFailure('2001:db8:5:5::1');
  lim.recordRegistrationFailure('2001:db8:5:5::2');
  assert.equal(lim.isRegistrationBlocked('2001:db8:5:5::99'), true);
});
