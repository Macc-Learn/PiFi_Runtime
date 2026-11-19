/** Spec §19 tests 1, 2, 3, 4, 9, 10, 12, 15: the app lifecycle, with real child processes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PifiError } from '../src/errors.js';
import { hashDirectory } from '../src/registry.js';
import { installApp, isPidAlive, makeHome, sleep, startDaemon, waitFor } from './helpers.js';

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

test('1. happy path: start -> request -> graceful stop; pid gone, port released', async () => {
  const home = await makeHome();
  await installApp(home, 'echo', { needsPort: true });
  const t = await startDaemon({ home });
  try {
    const { manager } = t.daemon;
    const info = await manager.start('echo');
    assert.equal(info.state, 'running');
    const rec = manager.records.get('echo')!;
    const pid = rec.pid!;
    const port = rec.port!;
    assert.ok(pid > 0 && port > 0, 'pid and port assigned');
    assert.equal(await canBind(port), true, 'port is only reserved by PiFi, not actually bound');

    const reply = (await manager.request('echo', { hello: 'world' })) as { echoed: unknown };
    assert.deepEqual(reply.echoed, { hello: 'world' });

    await manager.stop('echo');
    assert.equal(rec.state, 'stopped');
    assert.equal(rec.lastExit?.code, 0, 'graceful: app exited 0 on its own');
    assert.equal(rec.lastExit?.signal, null);
    await waitFor(() => !isPidAlive(pid), 2000, 'pid to disappear');
    assert.equal(rec.token, undefined, 'token invalidated');
    assert.equal(rec.port, undefined, 'port released');
    assert.equal(rec.ws, undefined);
  } finally {
    await t.cleanup();
  }
});

test('1b. start is idempotent and stop of a stopped app is a no-op', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    const [a, b] = await Promise.all([t.daemon.manager.start('echo'), t.daemon.manager.start('echo')]);
    assert.equal(a.pid, b.pid, 'concurrent starts share one process');
    await t.daemon.manager.stop('echo');
    await t.daemon.manager.stop('echo');
    assert.equal(t.daemon.manager.info('echo').state, 'stopped');
  } finally {
    await t.cleanup();
  }
});

test('2. stubborn app ignores shutdown and SIGTERM -> escalates to SIGKILL', async () => {
  const t = await startDaemon({ apps: ['stubborn'] });
  try {
    const rec = t.daemon.manager.records.get('stubborn')!;
    await t.daemon.manager.start('stubborn');
    const pid = rec.pid!;
    const began = Date.now();
    await t.daemon.manager.stop('stubborn');
    const took = Date.now() - began;
    assert.equal(rec.state, 'stopped');
    assert.equal(rec.lastExit?.signal, 'SIGKILL');
    assert.ok(took >= 500, `should wait through both grace periods, took ${took} ms`);
    assert.equal(isPidAlive(pid), false);
  } finally {
    await t.cleanup();
  }
});

test('2b. hard stop kills immediately', async () => {
  const t = await startDaemon({ apps: ['stubborn'], configOverrides: { gracefulStopMs: 5000, sigtermWaitMs: 5000 } });
  try {
    await t.daemon.manager.start('stubborn');
    const began = Date.now();
    await t.daemon.manager.stop('stubborn', { hard: true });
    assert.ok(Date.now() - began < 1500, 'did not wait for the grace periods');
    assert.equal(t.daemon.manager.records.get('stubborn')!.lastExit?.signal, 'SIGKILL');
  } finally {
    await t.cleanup();
  }
});

test('3. crashy app: crashed -> restarted up to the limit -> failed', async () => {
  const t = await startDaemon({ apps: ['crashy'] });
  try {
    const rec = t.daemon.manager.records.get('crashy')!;
    await t.daemon.manager.start('crashy');
    await waitFor(() => rec.state === 'failed', 8000, 'crashy to give up');
    assert.equal(rec.restartCount, 3, 'restarted exactly maxRestarts times');
    assert.match(rec.failReason ?? '', /restart limit/);
    assert.equal(rec.pid, undefined);
  } finally {
    await t.cleanup();
  }
});

test('3b. a deliberate stop does not trigger a restart', async () => {
  const home = await makeHome();
  await installApp(home, 'crashy', { env: { CRASH_AFTER_MS: '60000' } });
  const t = await startDaemon({ home });
  try {
    const rec = t.daemon.manager.records.get('crashy')!;
    await t.daemon.manager.start('crashy');
    await t.daemon.manager.stop('crashy');
    await sleep(400); // longer than the 20 ms restart backoff
    assert.equal(rec.state, 'stopped');
    assert.equal(rec.restartCount, 0);
    assert.equal(rec.pid, undefined);
  } finally {
    await t.cleanup();
  }
});

test('3c. restart policy "never" leaves the app crashed', async () => {
  const home = await makeHome();
  await installApp(home, 'crashy', { restart: { policy: 'never' } });
  const t = await startDaemon({ home });
  try {
    const rec = t.daemon.manager.records.get('crashy')!;
    await t.daemon.manager.start('crashy');
    await waitFor(() => rec.state === 'crashed', 3000, 'crash');
    await sleep(200);
    assert.equal(rec.state, 'crashed');
    assert.equal(rec.restartCount, 0);
  } finally {
    await t.cleanup();
  }
});

test('4. silent app never sends ready -> start timeout -> killed -> failed', async () => {
  const t = await startDaemon({ apps: ['silent'] });
  try {
    const rec = t.daemon.manager.records.get('silent')!;
    const attempt = t.daemon.manager.start('silent').then(() => undefined, (e: unknown) => e);
    await waitFor(() => rec.pid !== undefined, 2000, 'spawn');
    const pid = rec.pid!;
    const err = await attempt;
    assert.ok(err instanceof PifiError);
    assert.equal(err.code, 'START_TIMEOUT');
    assert.equal(rec.state, 'failed');
    assert.equal(rec.failReason, 'start timeout');
    await waitFor(() => !isPidAlive(pid), 2000, 'process to be killed');
  } finally {
    await t.cleanup();
  }
});

test('9. insufficient memory: refuses to start and spawns nothing', async () => {
  const t = await startDaemon({
    apps: ['echo'],
    readMemory: () => ({ totalMB: 512, availableMB: 100 }), // echo needs 60 + 100 margin
  });
  try {
    const rec = t.daemon.manager.records.get('echo')!;
    await assert.rejects(t.daemon.manager.start('echo'), (e: unknown) => e instanceof PifiError && e.code === 'INSUFFICIENT_MEMORY');
    assert.equal(rec.state, 'failed');
    assert.equal(rec.child, undefined);
    assert.equal(rec.pid, undefined);
    assert.match(rec.failReason ?? '', /insufficient memory/);
  } finally {
    await t.cleanup();
  }
});

test('10. hash verification: mismatch and missing hash refuse; correct hash runs; --dev bypasses', async () => {
  const home = await makeHome();
  const dir = await installApp(home, 'echo');
  const good = await hashDirectory(dir);

  // wrong hash
  await writeFile(path.join(dir, 'pifi.json'), JSON.stringify({ name: 'echo', version: '1.0.0', command: 'node', args: ['index.js'], memoryMB: 60, hash: 'sha256-' + '0'.repeat(64) }));
  let t = await startDaemon({ home, configOverrides: { dev: false }, keepHome: true });
  try {
    const rec = t.daemon.manager.records.get('echo')!;
    await assert.rejects(t.daemon.manager.start('echo'), (e: unknown) => e instanceof PifiError && e.code === 'HASH_MISMATCH');
    assert.equal(rec.state, 'failed');
    assert.equal(rec.failReason, 'hash mismatch');
    assert.equal(rec.child, undefined, 'nothing spawned');
  } finally {
    await t.cleanup();
  }

  // wrong hash but dev mode: runs
  t = await startDaemon({ home, configOverrides: { dev: true }, keepHome: true });
  try {
    assert.equal((await t.daemon.manager.start('echo')).state, 'running');
  } finally {
    await t.cleanup();
  }

  // no hash outside dev: refused
  await writeFile(path.join(dir, 'pifi.json'), JSON.stringify({ name: 'echo', version: '1.0.0', command: 'node', args: ['index.js'], memoryMB: 60 }));
  t = await startDaemon({ home, configOverrides: { dev: false }, keepHome: true });
  try {
    await assert.rejects(t.daemon.manager.start('echo'), (e: unknown) => e instanceof PifiError && e.code === 'HASH_MISMATCH');
  } finally {
    await t.cleanup();
  }

  // correct hash: runs; then tampering with a file makes the next start fail
  await writeFile(path.join(dir, 'pifi.json'), JSON.stringify({ name: 'echo', version: '1.0.0', command: 'node', args: ['index.js'], memoryMB: 60, hash: good }));
  t = await startDaemon({ home, configOverrides: { dev: false } });
  try {
    assert.equal((await t.daemon.manager.start('echo')).state, 'running');
    await t.daemon.manager.stop('echo');
    await writeFile(path.join(dir, 'index.js'), '// tampered\n');
    await assert.rejects(t.daemon.manager.start('echo'), (e: unknown) => e instanceof PifiError && e.code === 'HASH_MISMATCH');
  } finally {
    await t.cleanup();
  }
});

test('12. request timeout rejects and cleans up the pending entry', async () => {
  const t = await startDaemon({ apps: ['mute'] });
  try {
    const rec = t.daemon.manager.records.get('mute')!;
    await t.daemon.manager.start('mute');
    await assert.rejects(t.daemon.manager.request('mute', { x: 1 }), (e: unknown) => e instanceof PifiError && e.code === 'REQUEST_TIMEOUT');
    assert.equal(rec.router.size, 0, 'pending map is empty again');
    assert.equal(rec.state, 'running', 'a slow app is not a dead app');
  } finally {
    await t.cleanup();
  }
});

test('12b. requests to a stopped app are refused; pending requests fail when the app dies', async () => {
  const t = await startDaemon({ apps: ['mute'], configOverrides: { requestTimeoutMs: 5000 } });
  try {
    await assert.rejects(t.daemon.manager.request('mute', {}), (e: unknown) => e instanceof PifiError && e.code === 'NOT_RUNNING');
    await t.daemon.manager.start('mute');
    const pending = t.daemon.manager.request('mute', {}).then(() => undefined, (e: unknown) => e);
    await sleep(50);
    await t.daemon.manager.stop('mute');
    const err = await pending;
    assert.ok(err instanceof PifiError && err.code === 'APP_EXITED');
  } finally {
    await t.cleanup();
  }
});

test('15. daemon shutdown stops all children', async () => {
  const t = await startDaemon({ apps: ['echo', 'stubborn'] });
  const { manager } = t.daemon;
  await Promise.all([manager.start('echo'), manager.start('stubborn')]);
  const pids = [...manager.records.values()].map((r) => r.pid!);
  assert.equal(pids.length, 2);
  assert.ok(pids.every(isPidAlive));
  await t.daemon.stop();
  for (const pid of pids) assert.equal(isPidAlive(pid), false, `pid ${pid} should be gone`);
  assert.ok([...manager.records.values()].every((r) => r.state === 'stopped'));
  await t.cleanup();
});
