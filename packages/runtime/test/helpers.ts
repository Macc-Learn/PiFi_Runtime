/**
 * Shared test plumbing: build a throwaway PIFI_HOME, copy fixture apps into it,
 * and start a real Daemon on random ports with millisecond-scale timeouts.
 *
 * The temp folder lives INSIDE the repo (.tmp-tests/) on purpose: copied apps
 * `import "ws"`/"@pifi/sdk", and Node finds those by walking up to the repo's
 * node_modules. A folder in /tmp would not find them.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Daemon } from '../src/daemon.js';
import { loadConfig, type Config } from '../src/config.js';
import { silentLogger, type Logger } from '../src/logger.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { DaemonOptions } from '../src/daemon.js';
import type { MemoryReader } from '../src/resources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/test/helpers.js -> repo root is four levels up
export const REPO_ROOT = path.resolve(here, '../../../..');
const FIXTURES: Record<string, string> = {
  echo: 'examples/echo-app',
  stubborn: 'examples/test-fixtures/stubborn-app',
  crashy: 'examples/test-fixtures/crashy-app',
  silent: 'examples/test-fixtures/silent-app',
  mute: 'examples/test-fixtures/mute-app',
};

export async function makeHome(): Promise<string> {
  const base = path.join(REPO_ROOT, '.tmp-tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'home-'));
}

/** Copy a fixture into <home>/registered-apps/<name>, optionally patching its manifest. */
export async function installApp(
  home: string,
  name: keyof typeof FIXTURES & string,
  patch: Record<string, unknown> = {},
): Promise<string> {
  const dest = path.join(home, 'registered-apps', name);
  await cp(path.join(REPO_ROOT, FIXTURES[name] as string), dest, { recursive: true });
  const manifestPath = path.join(dest, 'pifi.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, JSON.stringify({ ...manifest, ...patch }, null, 2));
  return dest;
}

export interface TestDaemon {
  daemon: Daemon;
  home: string;
  config: Config;
  cleanup: () => Promise<void>;
}

export async function startDaemon(opts: {
  home?: string;
  apps?: Array<keyof typeof FIXTURES & string>;
  configOverrides?: Partial<Config>;
  readMemory?: MemoryReader;
  keepHome?: boolean;
  log?: Logger;
  signaling?: DaemonOptions['signaling'];
  transportFactory?: DaemonOptions['transportFactory'];
  appRequestTimeoutMs?: number;
} = {}): Promise<TestDaemon> {
  const home = opts.home ?? (await makeHome());
  for (const app of opts.apps ?? []) await installApp(home, app);
  const config = loadConfig({ PIFI_HOME: home }, {
    dev: true,
    appPort: 0,
    controlPort: 0,
    logLevel: 'silent',
    gracefulStopMs: 300,
    sigtermWaitMs: 300,
    restartBackoffBaseMs: 20,
    requestTimeoutMs: 400,
    helloTimeoutMs: 300,
    startTimeoutMs: 3000,
    ...opts.configOverrides,
  });
  const daemon = new Daemon({
    config,
    log: opts.log ?? silentLogger,
    readMemory: opts.readMemory ?? (() => ({ totalMB: 4096, availableMB: 2048 })),
    signaling: opts.signaling,
    transportFactory: opts.transportFactory,
    appRequestTimeoutMs: opts.appRequestTimeoutMs,
  });
  await daemon.start();
  return {
    daemon,
    home,
    config,
    cleanup: async () => {
      await daemon.stop().catch(() => undefined);
      if (!opts.keepHome) await rm(home, { recursive: true, force: true });
    },
  };
}

/** Poll until `check()` is truthy or the timeout passes. */
export async function waitFor(check: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Open a raw client socket and collect its close event. */
export function rawClient(port: number, opts: { origin?: string } = {}): {
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app`, opts.origin ? { origin: opts.origin } : {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()));
  ws.on('error', () => undefined);
  return { ws, closed, opened };
}

export const hello = (name: string, token: string): string =>
  JSON.stringify({ v: 1, type: 'hello', payload: { name, token, sdkVersion: 'test' } });

/** A Logger that records every line, so tests can assert what was (not) logged. */
export function memoryLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const rec = (lvl: string) => (m: string): void => { lines.push(`${lvl} ${m}`); };
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

/** node:http (not fetch) so tests can set forbidden headers like Origin and Host. */
export function call(port: number, opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
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

export const CLI_PATH = path.join(REPO_ROOT, 'packages/runtime/dist/src/cli.js');

/** Run the real `pifi` CLI against a test daemon. */
export function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function adminHeaders(home: string): Promise<Record<string, string>> {
  const token = (await readFile(path.join(home, 'admin.token'), 'utf8')).trim();
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}
