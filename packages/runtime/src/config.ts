/**
 * All tunable settings in one place (spec §9). Defaults come first, environment
 * variables override them, and tests override both with the `overrides` argument
 * (that's how tests get millisecond timeouts instead of 5-second ones).
 */
import os from 'node:os';
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
  /** Dev mode: skip hash verification (loudly); enables the signaling dev echo. */
  dev: boolean;
  /** Default lifetime of a pairing code (max 3600). */
  pairTtlSec: number;
  /** Signaling server WebSocket URL. Unset -> signaling disabled (Phase 1 behaviour). */
  signalUrl?: string;
  signalPingMs: number;
  signalBackoffMinMs: number;
  signalBackoffMaxMs: number;
  /** STUN/TURN URLs for WebRTC (PIFI_ICE_SERVERS, JSON array). TURN credentials come from env, never the repo. */
  iceServers: string[];
  maxSessions: number;
  maxPairedPhones: number;
  /** Shown to phones in the dashboard. */
  deviceName: string;
  /** A session with no traffic for this long is closed. */
  sessionIdleSec: number;
}

function iceServersFromEnv(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return ['stun:stun.l.google.com:19302'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PIFI_ICE_SERVERS must be a JSON array of URL strings');
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u))) {
    throw new Error('PIFI_ICE_SERVERS must be a JSON array of stun:/turn: URL strings');
  }
  return parsed as string[];
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
    pairTtlSec: intFromEnv(env, 'PIFI_PAIR_TTL_SEC', 600),
    signalUrl: env.PIFI_SIGNAL_URL || undefined,
    signalPingMs: intFromEnv(env, 'PIFI_SIGNAL_PING_MS', 25_000),
    signalBackoffMinMs: intFromEnv(env, 'PIFI_SIGNAL_BACKOFF_MIN_MS', 1_000),
    signalBackoffMaxMs: intFromEnv(env, 'PIFI_SIGNAL_BACKOFF_MAX_MS', 30_000),
    iceServers: iceServersFromEnv(env.PIFI_ICE_SERVERS),
    maxSessions: intFromEnv(env, 'PIFI_MAX_SESSIONS', 5),
    maxPairedPhones: intFromEnv(env, 'PIFI_MAX_PAIRED_PHONES', 10),
    deviceName: (env.PIFI_DEVICE_NAME || os.hostname()).slice(0, 64),
    sessionIdleSec: intFromEnv(env, 'PIFI_SESSION_IDLE_SEC', 45),
  };
  const config = { ...base, ...overrides };
  if (config.pairTtlSec < 1 || config.pairTtlSec > 3600) throw new Error('PIFI_PAIR_TTL_SEC must be between 1 and 3600');
  if (config.signalUrl && !/^wss?:\/\//.test(config.signalUrl)) throw new Error('PIFI_SIGNAL_URL must start with ws:// or wss://');
  if (config.signalBackoffMinMs < 1 || config.signalBackoffMaxMs < config.signalBackoffMinMs) {
    throw new Error('signal backoff: need 1 <= PIFI_SIGNAL_BACKOFF_MIN_MS <= PIFI_SIGNAL_BACKOFF_MAX_MS');
  }
  return config;
}
