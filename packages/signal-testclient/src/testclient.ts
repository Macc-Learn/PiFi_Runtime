#!/usr/bin/env node
/**
 *   node testclient.js status <deviceId> --url ws://localhost:8080/ws
 *   node testclient.js echo   <deviceId> --url ws://localhost:8080/ws --data hello
 *
 * `echo` only gets an answer from a daemon running with PIFI_DEV=1.
 */
import { parseArgs } from 'node:util';
import { echo, queryStatus } from './client.js';
import { connectDirect, loadState, pairFromLink, saveState, shutdownWebRtc } from './fakePhone.js';

const USAGE = `usage:
  testclient status <deviceId> [--url ws://localhost:8080/ws]
  testclient echo   <deviceId> [--url ws://localhost:8080/ws] [--data hello]      (dev echo, Phase 2)

  Full fake phone (Phase 3; the key is kept in --state, default ./fake-phone.json):
  testclient pair  '<link from pifi pair --json>' [--url ...] [--label "Fake phone"] [--state file]
  testclient apps  [--url ...] [--state file]                      list apps over a direct connection
  testclient call  <op> ['<json payload>'] [--app name] [--url ...] [--state file]`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string', default: 'ws://localhost:8080/ws' }, data: { type: 'string', default: 'hello' }, timeout: { type: 'string', default: '5000' },
      state: { type: 'string', default: 'fake-phone.json' }, label: { type: 'string', default: 'Fake phone' }, app: { type: 'string' },
    },
  });
  const [command, deviceId] = positionals;
  if (command === 'pair' || command === 'apps' || command === 'call') {
    try {
      return await phoneCommand(command, positionals.slice(1), values);
    } finally {
      await shutdownWebRtc();
    }
  }
  if (!command || !deviceId) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const timeout = Number(values.timeout);
  if (command === 'status') {
    console.log((await queryStatus(values.url, deviceId, timeout)) ? 'online' : 'offline');
  } else if (command === 'echo') {
    console.log(JSON.stringify(await echo(values.url, deviceId, values.data, timeout)));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

async function phoneCommand(command: string, args: string[], v: { url: string; state: string; label: string; app?: string }): Promise<void> {
  if (command === 'pair') {
    if (!args[0]) throw new Error('pair needs the link printed by `pifi pair`');
    const rec = await pairFromLink(args[0], v.url, v.label, { extractable: true });
    await saveState(v.state, rec);
    console.log(`paired with ${rec.deviceId.slice(0, 8)}…; this phone is ${rec.phoneId.slice(0, 8)}… (key saved in ${v.state})`);
    return;
  }
  const rec = await loadState(v.state);
  const { client, close } = await connectDirect(rec, v.url);
  try {
    if (command === 'apps') {
      console.log(JSON.stringify(await client.request('apps.list'), null, 2));
    } else {
      if (!args[0]) throw new Error('call needs an op');
      let payload: unknown;
      if (args[1] !== undefined) {
        try { payload = JSON.parse(args[1]); } catch { payload = args[1]; }
      }
      console.log(JSON.stringify(await client.request(args[0], payload, v.app ? { app: v.app } : {}), null, 2));
    }
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(`testclient: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
