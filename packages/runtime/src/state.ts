/**
 * Persistence: desired state (state.json) and last-known child pids (pids.json).
 * Spec §16.
 *
 * Both files are written ATOMICALLY: we write a temp file in the same folder and
 * then rename it over the real one. A rename is all-or-nothing, so if the Pi loses
 * power mid-write you get either the old file or the new one, never half of each.
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Logger } from './logger.js';

export async function writeJsonAtomic(file: string, data: unknown, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // The temp file gets its final mode at creation, so the content is never briefly world-readable.
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode, flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined); // don't leave temp litter behind
    throw err;
  }
}

async function readJsonOrUndefined(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined; // missing or corrupt: caller starts from empty
  }
}

export type Desired = 'running' | 'stopped';

/** state.json: which apps the user wants running. Survives reboots and daemon restarts. */
export class StateStore {
  private desired: Record<string, Desired> = {};
  /** Saves are chained so two quick saves can't rename over each other out of order. */
  private chain: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(home: string, private log: Logger) {
    this.file = path.join(home, 'state.json');
  }

  async load(): Promise<void> {
    const raw = (await readJsonOrUndefined(this.file)) as { desired?: Record<string, unknown> } | undefined;
    this.desired = {};
    for (const [name, value] of Object.entries(raw?.desired ?? {})) {
      if (value === 'running' || value === 'stopped') this.desired[name] = value;
    }
  }

  get(name: string): Desired | undefined {
    return this.desired[name];
  }

  set(name: string, value: Desired): Promise<void> {
    this.desired[name] = value;
    return this.save();
  }

  /** Resolves when all queued saves are on disk. */
  flush(): Promise<void> {
    return this.chain;
  }

  private save(): Promise<void> {
    const snapshot = { desired: { ...this.desired } };
    this.chain = this.chain
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((err) => this.log.error(`could not save state.json: ${err instanceof Error ? err.message : err}`));
    return this.chain;
  }
}

interface PidEntry {
  pid: number;
  command: string;
}

/** pids.json: children we started, so a crashed daemon's orphans can be cleaned up on the next boot. */
export class PidStore {
  private pids: Record<string, PidEntry> = {};
  private chain: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(home: string, private log: Logger) {
    this.file = path.join(home, 'pids.json');
  }

  async load(): Promise<Record<string, PidEntry>> {
    const raw = (await readJsonOrUndefined(this.file)) as { pids?: Record<string, PidEntry> } | undefined;
    return raw?.pids ?? {};
  }

  set(name: string, entry: PidEntry): void {
    this.pids[name] = entry;
    this.save();
  }

  remove(name: string): void {
    delete this.pids[name];
    this.save();
  }

  clear(): Promise<void> {
    this.pids = {};
    this.save();
    return this.chain;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private save(): void {
    const snapshot = { pids: { ...this.pids } };
    this.chain = this.chain
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((err) => this.log.error(`could not save pids.json: ${err instanceof Error ? err.message : err}`));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = "does this process exist?" without disturbing it
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort orphan cleanup. A pid number can be reused by an unrelated program
 * after a reboot, so on Linux we check /proc/<pid>/cmdline still mentions the
 * command we launched before sending anything. Elsewhere we can't verify, so we
 * only warn (killing a random process would be far worse than leaving an orphan).
 */
export async function killStalePids(store: PidStore, log: Logger): Promise<void> {
  const recorded = await store.load();
  for (const [name, entry] of Object.entries(recorded)) {
    if (!isAlive(entry.pid)) continue;
    if (process.platform !== 'linux') {
      log.warn(`app "${name}" (pid ${entry.pid}) may be an orphan from a previous run; cannot verify on ${process.platform}, leaving it`);
      continue;
    }
    let cmdline = '';
    try {
      cmdline = await readFile(`/proc/${entry.pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmdline.includes(path.basename(entry.command))) continue; // pid reused by something else
    log.warn(`terminating orphaned app "${name}" (pid ${entry.pid}) from a previous run`);
    try { process.kill(entry.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 30 && isAlive(entry.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (isAlive(entry.pid)) {
      try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  await store.clear();
}
