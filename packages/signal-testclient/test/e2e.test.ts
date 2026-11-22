/**
 * End to end (Phase 2 §11): real signaling server + real PiFi daemon + the real
 * test-client CLI. Then the server restarts and the Pi must find its way back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon, loadConfig } from '@pifi/runtime';
import { createLogger, createSignalingServer, loadServerConfig, type SignalingServer } from '@pifi/server';
import { echo, queryStatus } from '../src/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../../..');
const CLI = path.resolve(here, '../src/testclient.js');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function runTestClient(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer(port: number): Promise<SignalingServer> {
  const server = createSignalingServer(loadServerConfig({}, { host: '127.0.0.1', port }), { log: createLogger('silent') });
  await server.listen();
  return server;
}

test('phone -> server -> Pi echo, then the Pi reconnects after a server restart', async () => {
  let server = await startServer(0);
  const port = server.port;
  const url = `ws://127.0.0.1:${port}/ws`;

  await mkdir(path.join(REPO_ROOT, '.tmp-tests'), { recursive: true });
  const home = await mkdtemp(path.join(REPO_ROOT, '.tmp-tests', 'e2e-'));
  const config = loadConfig({ PIFI_HOME: home }, { dev: true, appPort: 0, controlPort: 0, logLevel: 'silent', signalUrl: url });
  const daemon = new Daemon({ config, log: quiet });
  await daemon.start();

  try {
    const { deviceId } = daemon.identity;
    await waitFor(() => daemon.signalingState().state === 'online', 5000, 'Pi online');

    // The CLI, exactly as a person would run it.
    const status = await runTestClient(['status', deviceId, '--url', url]);
    assert.equal(status.stdout.trim(), 'online', status.stderr);
    const reply = await runTestClient(['echo', deviceId, '--url', url, '--data', 'hello']);
    assert.equal(reply.code, 0, reply.stderr);
    assert.equal(reply.stdout.trim(), '"hello"');

    const offline = await runTestClient(['echo', 'a'.repeat(52), '--url', url]);
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /target-offline/);

    // Kill the server (graceful: sends 4100). The Pi notices...
    await server.shutdown();
    await waitFor(() => ['backoff', 'connecting'].includes(daemon.signalingState().state), 3000, 'Pi notices');
    assert.match(daemon.signalingState().lastError ?? '', /4100/);

    // ...and is back within the 0-3 s restart window once the server returns.
    server = await startServer(port);
    await waitFor(() => daemon.signalingState().state === 'online', 8000, 'Pi back online');
    assert.equal(await queryStatus(url, deviceId), true);
    assert.deepEqual(await echo(url, deviceId, { again: true }), { again: true });
  } finally {
    await daemon.stop();
    await server.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
