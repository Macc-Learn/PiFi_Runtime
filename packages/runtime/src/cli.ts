#!/usr/bin/env node
/**
 * The `pifi` command-line tool (spec §17). Apart from `daemon` and `hash`, every
 * command is just a tiny HTTP client for the control API. It finds the daemon via
 * the same environment variables the daemon uses (PIFI_HOME, PIFI_CONTROL_PORT,
 * PIFI_DEV), so set them the same way for both.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { hashDirectory, registeredAppsDir } from './registry.js';
import { runDaemon } from './index.js';

const USAGE = `pifi <command>

  daemon [--dev]            run the PiFi daemon in the foreground
  list                      list apps and their state
  status                    daemon + memory summary
  start <app>               start an app
  stop <app> [--hard]       stop an app (--hard = SIGKILL immediately)
  restart <app>             stop then start
  send <app> '<json|text>'  send a request to a running app and print the response
  logs <app>                show the app's recent output
  hash <app>                print the hash to paste into the app's pifi.json
  reload                    re-scan registered-apps/

Environment: PIFI_HOME, PIFI_CONTROL_PORT, PIFI_DEV=1 (dev data dir ./pifi-data)`;

async function api(method: string, route: string, body?: unknown): Promise<unknown> {
  const config = loadConfig();
  let token: string;
  try {
    token = (await readFile(path.join(config.home, 'admin.token'), 'utf8')).trim();
  } catch {
    throw new Error(`cannot read ${path.join(config.home, 'admin.token')} (has the daemon run once? is PIFI_HOME right?)`);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.controlPort}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`cannot reach the daemon on port ${config.controlPort}; is it running? (try: pifi daemon)`);
  }
  const json = (await res.json()) as { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${json.error?.code ?? res.status}: ${json.error?.message ?? 'request failed'}`);
  return json;
}

function printTable(rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return void console.log('(no apps registered)');
  const cols = Object.keys(rows[0] as Record<string, string>);
  const width = (c: string): number => Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length));
  console.log(cols.map((c) => c.toUpperCase().padEnd(width(c))).join('  '));
  for (const r of rows) console.log(cols.map((c) => (r[c] ?? '').padEnd(width(c))).join('  '));
}

function formatUptime(ms: number | undefined): string {
  if (ms === undefined) return '-';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

interface ListedApp {
  name: string; state: string; pid?: number; port?: number; uptimeMs?: number; restarts: number; failReason?: string;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { dev: { type: 'boolean' }, hard: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, arg, ...rest] = positionals;
  if (values.dev) process.env.PIFI_DEV = '1';
  if (!command || values.help) return void console.log(USAGE);

  const needApp = (): string => {
    if (!arg) throw new Error(`"${command}" needs an app name`);
    return encodeURIComponent(arg);
  };

  switch (command) {
    case 'daemon':
      await runDaemon(loadConfig());
      return; // the open sockets keep the process alive
    case 'list': {
      const { apps } = (await api('GET', '/apps')) as { apps: ListedApp[] };
      printTable(apps.map((a) => ({
        name: a.name, state: a.state, pid: String(a.pid ?? '-'), port: String(a.port ?? '-'),
        uptime: formatUptime(a.uptimeMs), restarts: String(a.restarts), note: a.failReason ?? '',
      })));
      return;
    }
    case 'status':
      console.log(JSON.stringify(await api('GET', '/status'), null, 2));
      return;
    case 'start':
    case 'restart':
      console.log(JSON.stringify(await api('POST', `/apps/${needApp()}/${command}`), null, 2));
      return;
    case 'stop':
      console.log(JSON.stringify(await api('POST', `/apps/${needApp()}/stop${values.hard ? '?hard=true' : ''}`), null, 2));
      return;
    case 'send': {
      const text = rest.join(' ');
      let payload: unknown = text;
      try { payload = JSON.parse(text); } catch { /* not JSON: send the text as a string */ }
      console.log(JSON.stringify(await api('POST', `/apps/${needApp()}/request`, { payload }), null, 2));
      return;
    }
    case 'logs': {
      const detail = (await api('GET', `/apps/${needApp()}`)) as { logTail: string[] };
      console.log(detail.logTail.join('\n'));
      return;
    }
    case 'hash': {
      // Computed locally; needs no running daemon.
      if (!arg) throw new Error('"hash" needs an app name');
      console.log(await hashDirectory(path.join(registeredAppsDir(loadConfig().home), arg)));
      return;
    }
    case 'reload':
      console.log(JSON.stringify(await api('POST', '/reload'), null, 2));
      return;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`pifi: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
