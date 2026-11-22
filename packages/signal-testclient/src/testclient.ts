#!/usr/bin/env node
/**
 *   node testclient.js status <deviceId> --url ws://localhost:8080/ws
 *   node testclient.js echo   <deviceId> --url ws://localhost:8080/ws --data hello
 *
 * `echo` only gets an answer from a daemon running with PIFI_DEV=1.
 */
import { parseArgs } from 'node:util';
import { echo, queryStatus } from './client.js';

const USAGE = `usage:
  testclient status <deviceId> [--url ws://localhost:8080/ws]
  testclient echo   <deviceId> [--url ws://localhost:8080/ws] [--data hello]`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { url: { type: 'string', default: 'ws://localhost:8080/ws' }, data: { type: 'string', default: 'hello' }, timeout: { type: 'string', default: '5000' } },
  });
  const [command, deviceId] = positionals;
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

main().catch((err) => {
  console.error(`testclient: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
