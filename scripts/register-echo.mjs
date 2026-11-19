// Copies examples/echo-app into ${PIFI_HOME}/registered-apps/echo (dev helper).
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.resolve(process.env.PIFI_HOME ?? './pifi-data');
const dest = path.join(home, 'registered-apps', 'echo');

await mkdir(path.dirname(dest), { recursive: true });
await rm(dest, { recursive: true, force: true });
await cp(path.join(root, 'examples/echo-app'), dest, { recursive: true });
console.log(`registered echo app at ${dest}`);
