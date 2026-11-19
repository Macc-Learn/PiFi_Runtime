/** Spec §19 tests 5, 6, 7, 8: what the local WebSocket server refuses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloseCode } from '@pifi/protocol';
import { hello, rawClient, startDaemon } from './helpers.js';

test('5. bad token -> closed with 4001', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    await t.daemon.manager.start('echo');
    const c = rawClient(t.daemon.appPort);
    await c.opened;
    c.ws.send(hello('echo', 'f'.repeat(64)));
    assert.equal((await c.closed).code, CloseCode.BAD_TOKEN);
    assert.equal(t.daemon.manager.info('echo').state, 'running', 'the real app is unaffected');
  } finally {
    await t.cleanup();
  }
});

test('5b. hello for an app that is registered but not running -> 4001; unknown app -> 4003', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    const a = rawClient(t.daemon.appPort);
    await a.opened;
    a.ws.send(hello('echo', 'a'.repeat(64)));
    assert.equal((await a.closed).code, CloseCode.BAD_TOKEN);

    const b = rawClient(t.daemon.appPort);
    await b.opened;
    b.ws.send(hello('nope', 'a'.repeat(64)));
    assert.equal((await b.closed).code, CloseCode.UNKNOWN_APP);
  } finally {
    await t.cleanup();
  }
});

test('6. Origin header present -> closed with 4004', async () => {
  const t = await startDaemon();
  try {
    const c = rawClient(t.daemon.appPort, { origin: 'http://evil.example' });
    assert.equal((await c.closed).code, CloseCode.ORIGIN_NOT_ALLOWED);
  } finally {
    await t.cleanup();
  }
});

test('7. second connection for the same app -> 4002 (even with the right token)', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    await t.daemon.manager.start('echo');
    const token = t.daemon.manager.records.get('echo')!.token!; // tests may peek; no API ever returns it
    const c = rawClient(t.daemon.appPort);
    await c.opened;
    c.ws.send(hello('echo', token));
    assert.equal((await c.closed).code, CloseCode.DUPLICATE_CONNECTION);
    assert.equal(t.daemon.manager.info('echo').state, 'running');
    assert.deepEqual(((await t.daemon.manager.request('echo', 1)) as { echoed: number }).echoed, 1);
  } finally {
    await t.cleanup();
  }
});

test('8. no hello in time, bad JSON, wrong first message, binary frame -> 4005', async () => {
  const t = await startDaemon();
  try {
    const silent = rawClient(t.daemon.appPort);
    assert.equal((await silent.closed).code, CloseCode.PROTOCOL_VIOLATION, 'hello timeout');

    for (const frame of ['not json', JSON.stringify({ v: 1, type: 'ready' }), JSON.stringify({ v: 2, type: 'hello' })]) {
      const c = rawClient(t.daemon.appPort);
      await c.opened;
      c.ws.send(frame);
      assert.equal((await c.closed).code, CloseCode.PROTOCOL_VIOLATION, frame);
    }

    const bin = rawClient(t.daemon.appPort);
    await bin.opened;
    bin.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await bin.closed).code, CloseCode.PROTOCOL_VIOLATION, 'binary frame');
  } finally {
    await t.cleanup();
  }
});

test('8b. oversized frame is refused (ws closes with 1009)', async () => {
  const t = await startDaemon({ configOverrides: { maxPayload: 1024 } });
  try {
    const c = rawClient(t.daemon.appPort);
    await c.opened;
    c.ws.send('x'.repeat(5000));
    assert.equal((await c.closed).code, 1009);
  } finally {
    await t.cleanup();
  }
});
