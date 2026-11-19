/**
 * All tunable settings in one place (spec §9). Defaults come first, environment
 * variables override them, and tests override both with the `overrides` argument
 * (that's how tests get millisecond timeouts instead of 5-second ones).
 */
import path from 'node:path';
import type { LogLevel } from './logger.js';
import { HELLO_TIMEOUT_MS } from '@pifi/protocol';

export interface Config {
  /** PIFI_HOME: where manifests, state, logs and the admin token live. */
  home: string;
  /** Port for the app WebSocket server. 0 = let the OS pick (tests). */
  appPort: number;
  /** Port for the control HTTP API. 0 = let the OS pick (tests). */
  controlPort: number;
  /** Default time an app has to reach `ready`. A manifest can override it. */
  startTimeoutMs: number;
  /** After sending `shutdown`, wait this long before SIGTERM. */
  gracefulStopMs: number;
  /** After SIGTERM, wait this long before SIGKILL. */
  sigtermWaitMs: number;
  /** First restart delay; doubles each restart in the window (1s, 2s, 4s...). */
  restartBackoffBaseMs: number;
  /** RAM that must remain free after an app's own `memoryMB` is accounted for. */
  memMarginMB: number;
  /** Largest WebSocket frame we accept from an app. */
  maxPayload: number;
  /** How long `request()` waits for the app's response. */
  requestTimeoutMs: number;
  /** How long a fresh connection has to say `hello`. */
  helloTimeoutMs: number;
  logLevel: LogLevel;
  /** Dev mode: skip hash verification (loudly). */
  dev: boolean;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dev = overrides.dev ?? (env.PIFI_DEV === '1' || env.PIFI_DEV === 'true');
  // On a Pi the data dir is /var/lib/pifi; in dev we keep it next to where you run the command.
  const home = path.resolve(env.PIFI_HOME ?? (dev ? './pifi-data' : '/var/lib/pifi'));
  const level = (env.PIFI_LOG_LEVEL ?? 'info') as LogLevel;

  const base: Config = {
    home,
    appPort: intFromEnv(env, 'PIFI_APP_PORT', 7777),
    controlPort: intFromEnv(env, 'PIFI_CONTROL_PORT', 7778),
    startTimeoutMs: 15_000,
    gracefulStopMs: 5_000,
    sigtermWaitMs: 5_000,
    restartBackoffBaseMs: 1_000,
    memMarginMB: intFromEnv(env, 'PIFI_MEM_MARGIN_MB', 100),
    maxPayload: 1024 * 1024,
    requestTimeoutMs: 10_000,
    helloTimeoutMs: HELLO_TIMEOUT_MS,
    logLevel: level,
    dev,
  };
  return { ...base, ...overrides };
}
