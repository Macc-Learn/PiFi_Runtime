/** Spec §19 tests 11, 13, 14, plus unit tests for the small pure pieces. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRegistry, hashDirectory, registeredAppsDir } from '../src/registry.js';
import { parseMeminfoKb } from '../src/resources.js';
import { substitutePort } from '../src/appRecord.js';
import { Router } from '../src/router.js';
import { StateStore } from '../src/state.js';
import { silentLogger } from '../src/logger.js';
import { installApp, makeHome, startDaemon, waitFor } from './helpers.js';

async function writeManifest(home: string, folder: string, content: unknown): Promise<void> {
  const dir = path.join(registeredAppsDir(home), folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pifi.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

const valid = { version: '1.0.0', command: 'node', memoryMB: 10 };

test('11. invalid manifests are rejected without crashing; valid apps still load', async () => {
  const home = await makeHome();
  await installApp(home, 'echo');
  await writeManifest(home, 'Bad_Name', { ...valid, name: 'Bad_Name' });
  await writeManifest(home, 'mismatch', { ...valid, name: 'other' });
  await writeManifest(home, 'traversal', { ...valid, name: '../evil' });
  await writeManifest(home, 'extra-key', { ...valid, name: 'extra-key', autostrat: true });
  await writeManifest(home, 'broken-json', '{ nope');
  await writeManifest(home, 'bad-memory', { ...valid, name: 'bad-memory', memoryMB: -5 });

  const scan = await loadRegistry(home);
  assert.deepEqual(scan.entries.map((e) => e.manifest.name), ['echo']);
  assert.equal(scan.errors.length, 6);
  assert.ok(scan.errors.some((e) => /does not match its folder/.test(e.error)));

  // The daemon boots anyway and can run the good app.
  const t = await startDaemon({ home });
  try {
    assert.deepEqual(t.daemon.manager.list().map((a) => a.name), ['echo']);
    assert.equal((await t.daemon.manager.start('echo')).state, 'running');
  } finally {
    await t.cleanup();
  }
});

test('manifest defaults are applied', async () => {
  const home = await makeHome();
  await writeManifest(home, 'minimal', { ...valid, name: 'minimal' });
  const { entries } = await loadRegistry(home);
  const m = entries[0]!.manifest;
  assert.deepEqual(m.restart, { policy: 'on-crash', maxRestarts: 3, windowSec: 60 });
  assert.equal(m.needsPort, false);
  assert.equal(m.autostart, false);
  assert.deepEqual(m.args, []);
  await t_cleanup(home);
});

async function t_cleanup(home: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(home, { recursive: true, force: true });
}

/** node:http (not fetch) so tests can set forbidden headers like Origin and Host. */
function call(port: number, opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: opts.path ?? '/apps', method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('13. control API: missing/wrong token -> 401; browser-ish requests -> 403', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    const port = t.daemon.controlPort;
    const token = (await readFile(path.join(t.home, 'admin.token'), 'utf8')).trim();
    const auth = { authorization: `Bearer ${token}` };

    assert.equal((await call(port, {})).status, 401, 'no token');
    assert.equal((await call(port, { headers: { authorization: 'Bearer wrong' } })).status, 401, 'wrong token');
    assert.equal((await call(port, { headers: { authorization: token } })).status, 401, 'missing Bearer prefix');
    assert.equal((await call(port, { headers: { ...auth, origin: 'http://evil.example' } })).status, 403, 'Origin present');
    assert.equal((await call(port, { headers: { ...auth, host: 'evil.example' } })).status, 403, 'non-loopback Host');
    assert.equal((await call(port, { headers: auth })).status, 200, 'correct token');
    assert.equal((await call(port, { path: '/nope', headers: auth })).status, 404);
    assert.equal((await call(port, { path: '/apps/Not%20Valid', headers: auth })).status, 404);
    assert.equal((await call(port, { path: '/apps/ghost', headers: auth })).status, 404);
  } finally {
    await t.cleanup();
  }
});

test('13b. control API drives an app end to end and never leaks the app token', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    const port = t.daemon.controlPort;
    const token = (await readFile(path.join(t.home, 'admin.token'), 'utf8')).trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const started = await call(port, { path: '/apps/echo/start', method: 'POST', headers });
    assert.equal(started.status, 200);
    assert.equal(JSON.parse(started.body).state, 'running');

    const sent = await call(port, { path: '/apps/echo/request', method: 'POST', headers, body: JSON.stringify({ payload: { a: 1 } }) });
    assert.deepEqual(JSON.parse(sent.body).payload.echoed, { a: 1 });

    const appToken = t.daemon.manager.records.get('echo')!.token!;
    for (const route of ['/apps/echo', '/apps', '/status']) {
      const res = await call(port, { path: route, headers });
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes(appToken), `${route} must not contain the app token`);
    }
    const detail = JSON.parse((await call(port, { path: '/apps/echo', headers })).body);
    assert.ok(detail.logTail.some((l: string) => l.includes('echo: got request')), 'stdout is captured in logTail');

    const status = JSON.parse((await call(port, { path: '/status', headers })).body);
    assert.equal(status.memory.availableMB, 2048);

    const stopped = await call(port, { path: '/apps/echo/stop', method: 'POST', headers });
    assert.equal(JSON.parse(stopped.body).state, 'stopped');
    const notRunning = await call(port, { path: '/apps/echo/request', method: 'POST', headers, body: '{}' });
    assert.equal(notRunning.status, 409);
    const bad = await call(port, { path: '/apps/echo/request', method: 'POST', headers, body: '{not json' });
    assert.ok(bad.status === 400 || bad.status === 409);
  } finally {
    await t.cleanup();
  }
});

test('13c. admin token file is created with owner-only permissions', { skip: process.platform === 'win32' }, async () => {
  const t = await startDaemon();
  try {
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(path.join(t.home, 'admin.token'))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await t.cleanup();
  }
});

test('14. desired state survives a daemon restart (and an explicit stop beats autostart)', async () => {
  const home = await makeHome();
  await installApp(home, 'echo', { autostart: true });

  // Run 1: autostart brings echo up (this does not write state.json); daemon shuts down gracefully.
  let t = await startDaemon({ home, keepHome: true });
  try {
    await waitFor(() => t.daemon.manager.info('echo').state === 'running', 5000, 'autostart');
    await t.daemon.state.flush();
  } finally {
    await t.cleanup();
  }
  assert.equal(t.daemon.manager.info('echo').state, 'stopped', 'children were stopped at shutdown');

  // Run 2: nothing was asked explicitly; autostart brings it back. Then the user stops it on purpose.
  t = await startDaemon({ home, keepHome: true });
  try {
    await waitFor(() => t.daemon.manager.info('echo').state === 'running', 5000, 'echo back after restart');
    await t.daemon.manager.stop('echo');
    await t.daemon.state.flush();
  } finally {
    await t.cleanup();
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'state.json'), 'utf8')), { desired: { echo: 'stopped' } });

  // Run 3: autostart:true in the manifest, but the user's explicit "stopped" wins.
  t = await startDaemon({ home, keepHome: true });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(t.daemon.manager.info('echo').state, 'stopped');
    // Run 3b: explicit start is remembered across a restart.
    await t.daemon.manager.start('echo');
    await t.daemon.state.flush();
  } finally {
    await t.cleanup();
  }
  t = await startDaemon({ home });
  try {
    await waitFor(() => t.daemon.manager.info('echo').state === 'running', 5000, 'desired-running app to return');
  } finally {
    await t.cleanup();
  }
});

test('14b. state.json writes are atomic: valid JSON after racing saves, no temp files left', async () => {
  const home = await makeHome();
  const store = new StateStore(home, silentLogger);
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.set(`app-${i}`, i % 2 ? 'running' : 'stopped')));
  await store.flush();
  const parsed = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(Object.keys(parsed.desired).length, 25);
  assert.deepEqual((await readdir(home)).filter((f) => f.endsWith('.tmp')), []);

  const reloaded = new StateStore(home, silentLogger);
  await reloaded.load();
  assert.equal(reloaded.get('app-1'), 'running');
  assert.equal(reloaded.get('app-2'), 'stopped');
  await t_cleanup(home);
});

test('a corrupt state.json is ignored instead of crashing the daemon', async () => {
  const home = await makeHome();
  await writeFile(path.join(home, 'state.json'), '{ garbage');
  const store = new StateStore(home, silentLogger);
  await store.load();
  assert.equal(store.get('echo'), undefined);
  await t_cleanup(home);
});

// ---- small pure pieces ----

test('parseMeminfoKb reads MemAvailable from /proc/meminfo text', () => {
  const sample = 'MemTotal:        3884052 kB\nMemFree:          212340 kB\nMemAvailable:    2450120 kB\n';
  assert.equal(parseMeminfoKb(sample, 'MemAvailable'), 2450120);
  assert.equal(parseMeminfoKb(sample, 'MemTotal'), 3884052);
  assert.equal(parseMeminfoKb(sample, 'Nope'), undefined);
});

test('substitutePort replaces {{PORT}} only when a port is allocated', () => {
  assert.deepEqual(substitutePort(['--port', '{{PORT}}', 'x{{PORT}}y'], 4321), ['--port', '4321', 'x4321y']);
  assert.deepEqual(substitutePort(['--port', '{{PORT}}'], undefined), ['--port', '{{PORT}}']);
});

test('Router correlates responses by id, times out, and rejects all on demand', async () => {
  const r = new Router();
  const a = r.create(1000);
  const b = r.create(1000);
  assert.equal(r.size, 2);
  assert.equal(r.settle(b.id, { payload: 'B' }), true);
  assert.equal(await b.promise, 'B');
  assert.equal(r.settle('unknown', { payload: 1 }), false);
  r.settle(a.id, { error: { code: 'X', message: 'boom' } });
  await assert.rejects(a.promise, /X: boom/);

  const slow = r.create(20);
  await assert.rejects(slow.promise, /no response within 20 ms/);
  const c = r.create(1000);
  r.rejectAll(new Error('gone'));
  await assert.rejects(c.promise, /gone/);
  assert.equal(r.size, 0);
});

test('hashDirectory ignores pifi.json and node_modules, and changes when a file changes', async () => {
  const home = await makeHome();
  const dir = path.join(home, 'app');
  await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await mkdir(path.join(dir, 'sub'), { recursive: true });
  await writeFile(path.join(dir, 'a.js'), 'one');
  await writeFile(path.join(dir, 'sub', 'b.js'), 'two');
  const h1 = await hashDirectory(dir);
  assert.match(h1, /^sha256-[0-9a-f]{64}$/);

  await writeFile(path.join(dir, 'pifi.json'), '{"changed":true}');
  await writeFile(path.join(dir, 'node_modules', 'x', 'i.js'), 'ignored');
  assert.equal(await hashDirectory(dir), h1, 'excluded files do not affect the hash');

  await writeFile(path.join(dir, 'sub', 'b.js'), 'TWO');
  assert.notEqual(await hashDirectory(dir), h1);
  await t_cleanup(home);
});
