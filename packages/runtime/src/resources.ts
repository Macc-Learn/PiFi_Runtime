/**
 * Memory checks (spec §13).
 *
 * On Linux we read `MemAvailable` from /proc/meminfo. That number is the
 * kernel's own estimate of "how much could a new program use right now",
 * and it counts reclaimable file cache as available. `os.freemem()` does not,
 * so on a busy Pi it would wrongly report almost no memory.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import type { Logger } from './logger.js';

export interface MemoryInfo {
  totalMB: number;
  availableMB: number;
}

/** Injected into the app manager so tests can pretend the Pi is out of RAM. */
export type MemoryReader = () => Promise<MemoryInfo> | MemoryInfo;

const MB = 1024 * 1024;

/** Pull a "Key:   12345 kB" value out of /proc/meminfo-style text. Returns kB, or undefined. */
export function parseMeminfoKb(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
  return match?.[1] ? Number(match[1]) : undefined;
}

let warnedFallback = false;

export function createMemoryReader(log: Logger): MemoryReader {
  return async () => {
    if (process.platform === 'linux') {
      try {
        const text = await readFile('/proc/meminfo', 'utf8');
        const total = parseMeminfoKb(text, 'MemTotal');
        const avail = parseMeminfoKb(text, 'MemAvailable');
        if (total !== undefined && avail !== undefined) {
          return { totalMB: Math.floor(total / 1024), availableMB: Math.floor(avail / 1024) };
        }
      } catch {
        // fall through to the portable fallback
      }
    }
    if (!warnedFallback) {
      warnedFallback = true;
      log.warn('using os.freemem() for the memory check; it under-reports available RAM (only Linux has MemAvailable)');
    }
    return { totalMB: Math.floor(os.totalmem() / MB), availableMB: Math.floor(os.freemem() / MB) };
  };
}

/** Resident memory of a process in MB. Only cheap on Linux; returns undefined elsewhere. */
export async function readRssMB(pid: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const text = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = parseMeminfoKb(text, 'VmRSS');
    return kb === undefined ? undefined : Math.round(kb / 1024);
  } catch {
    return undefined; // process vanished between listing and reading
  }
}
