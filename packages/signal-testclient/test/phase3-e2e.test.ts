/**
 * Phase 3 end to end, with nothing faked: the signaling server, a PiFi daemon
 * using real node-datachannel WebRTC, the real echo app, and a phone running the
 * shell's own core code (WebCrypto + node-datachannel's RTCPeerConnection).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon, loadConfig } from '@pifi/runtime';
import { createLogger, createSignalingServer, loadServerConfig, type SignalingServer } from '@pifi/server';
import { connectDirect, connectionManager, pairFromLink, shutdownWebRtc } from '../src/fakePhone.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../../..');
const CLI = path.resolve(here, '../src/testclient.js');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
/** E2E_TIMING=1 prints how long each stage took (to spot slow paths). */
const T0 = Date.now();
const lap = (stage: string): void => { if (process.env.E2E_TIMING) console.log(`T+${((Date.now() - T0) / 1000).toFixed(1)}s ${stage}`); };

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer(port: number): Promise<SignalingServer> {
  const s = createSignalingServer(loadServerConfig({}, { host: '127.0.0.1', port }), { log: createLogger('silent') });
  await s.listen();
  return s;
}

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('pair -> direct session -> apps, echo, events, stream -> server restart -> revoke', { timeout: 120_000 }, async () => {
  let server = await startServer(0);
  const port = server.port;
  const url = `ws://127.0.0.1:${port}/ws`;
  await mkdir(path.join(REPO_ROOT, '.tmp-tests'), { recursive: true });
  const home = await mkdtemp(path.join(REPO_ROOT, '.tmp-tests', 'e2e3-'));
  await cp(path.join(REPO_ROOT, 'examples/echo-app'), path.join(home, 'registered-apps/echo'), { recursive: true });
  const daemon = new Daemon({
    config: loadConfig({ PIFI_HOME: home }, { dev: true, appPort: 0, controlPort: 0, logLevel: 'silent', signalUrl: url, iceServers: [] }),
    log: quiet,
  });
  await daemon.start();
  const stops: Array<() => unknown> = [];

  try {
    await waitFor(() => daemon.signalingState().state === 'online', 5000, 'Pi online');
    const { deviceId } = daemon.identity;

    lap('pi online');
    // ---- pairing with a real code (as if scanned from `pifi pair`) ----
    const code = daemon.pairing.create(60);
    const phone = await pairFromLink(`https://shell.example/pair#id=${deviceId}&s=${code.secret}`, url, 'E2E phone');
    assert.equal(phone.keyPair.privateKey.extractable, false, 'shell-style key: not extractable');
    assert.equal(daemon.paired.get(phone.phoneId)?.label, 'E2E phone');
    assert.equal(daemon.pairing.status().active, false, 'code burned');

    lap('paired');
    // ---- direct session through the connection manager ----
    const cm = await connectionManager(phone, url);
    stops.push(() => cm.stop());
    cm.start();
    await waitFor(() => cm.state.state === 'online', 15_000, 'phone online');
    await waitFor(() => daemon.sessions.count === 1, 2000, 'Pi sees the session');
    const client = cm.client!;

    lap('session open');
    const apps = (await client.request('apps.list')) as Array<{ name: string; frontend?: string }>;
    assert.ok(apps.some((a) => a.name === 'echo' && a.frontend?.startsWith('https://')));
    assert.deepEqual(await client.request('apps.start', { name: 'echo' }), { state: 'running' });
    assert.deepEqual(await client.request('echo', { hi: 'from the phone' }, { app: 'echo' }), { hi: 'from the phone' });

    lap('echo request done');
    // events
    const counts: unknown[] = [];
    client.subscribe('echo');
    client.onEvent((app, name, data) => { if (app === 'echo' && name === 'count') counts.push(data); });
    await client.request('count', { intervalMs: 50 }, { app: 'echo' });
    await waitFor(() => counts.length >= 3, 5000, 'count events');
    await client.request('stop', undefined, { app: 'echo' });

    lap('events done');
    // stream: 300 KiB up, the same bytes back
    const sent = new Uint8Array(300 * 1024).map((_, i) => (i * 31) % 256);
    const stream = await client.openStream('echo', 'upload-echo', { size: sent.length });
    const got: Uint8Array[] = [];
    let ended = false;
    stream.onData((c) => got.push(c));
    stream.onEnd(() => { ended = true; });
    await stream.write(sent);
    stream.end();
    await waitFor(() => ended, 15_000, 'echoed stream to end');
    assert.ok(Buffer.concat(got).equals(Buffer.from(sent)), 'every byte came back');

    lap('stream done');
    // ---- the CLI fake phone, in its own processes ----
    const code2 = daemon.pairing.create(60);
    const state = path.join(home, 'cli-phone.json');
    const paired = await cli(['pair', `https://shell.example/pair#id=${deviceId}&s=${code2.secret}`, '--url', url, '--state', state, '--label', 'CLI phone']);
    assert.equal(paired.code, 0, paired.stderr);
    lap('cli paired');
    const listed = await cli(['apps', '--url', url, '--state', state]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok((JSON.parse(listed.stdout) as Array<{ name: string }>).some((a) => a.name === 'echo'));
    lap('cli apps done');
    const called = await cli(['call', 'echo', '{"n":1}', '--app', 'echo', '--url', url, '--state', state]);
    assert.deepEqual(JSON.parse(called.stdout), { n: 1 });

    lap('cli call done');
    // ---- signaling server restart: the P2P channel doesn't even notice; the Pi re-registers ----
    await server.shutdown();
    await waitFor(() => daemon.signalingState().state !== 'online', 3000, 'Pi notices the server went away');
    assert.deepEqual(await client.request('echo', 'still direct', { app: 'echo' }), 'still direct', 'data channel survives the server restart');
    lap('server down');
    server = await startServer(port);
    await waitFor(() => daemon.signalingState().state === 'online', 10_000, 'Pi back online');
    lap('Pi back online');
    const fresh = await connectDirect(phone, url);
    stops.push(fresh.close);
    assert.equal(((await fresh.client.request('status')) as { deviceId: string }).deviceId, deviceId, 'new sessions work after the restart');
    fresh.close();

    lap('fresh session done');
    // ---- revoke: the live session closes at once, and the phone can't come back ----
    await waitFor(() => cm.state.state === 'online', 10_000, 'phone online before revoke');
    daemon.sessions.revoke(phone.phoneId);
    await waitFor(() => cm.state.state === 'offline', 15_000, 'phone told it is no longer paired');
    assert.equal(cm.state.reason, 'NOT_PAIRED');
    assert.equal(daemon.paired.get(phone.phoneId), undefined);
    lap('revoked');
  } finally {
    for (const stop of stops) { try { await stop(); } catch { /* best effort */ } }
    await daemon.stop();
    await server.shutdown();
    await rm(home, { recursive: true, force: true });
    await shutdownWebRtc();
    lap('cleaned up');
  }
});
