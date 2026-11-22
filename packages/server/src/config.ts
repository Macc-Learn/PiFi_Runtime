/**
 * Server settings. The three the spec names are environment variables
 * (PORT, MAX_PHONES_PER_IP, LOG_LEVEL, plus TRUST_PROXY and HOST); the timing and
 * rate-limit numbers are constants with test overrides.
 */
import { MAX_SIGNAL_FRAME_BYTES } from '@pifi/protocol';
import type { LogLevel } from './logger.js';

export interface ServerConfig {
  /** 0.0.0.0 in production (Cloud Run requires it); tests use 127.0.0.1. */
  host: string;
  /** Cloud Run injects PORT. 0 = pick a free port (tests). */
  port: number;
  maxPhonesPerIp: number;
  logLevel: LogLevel;
  /** Behind Cloud Run: take the client IP from the LAST X-Forwarded-For entry. */
  trustProxy: boolean;
  /** Server -> client WebSocket ping. A client that missed the previous ping is terminated. */
  pingIntervalMs: number;
  /** Pi must answer the challenge within this. */
  authTimeoutMs: number;
  /** A nonce is single-use and expires after this. */
  nonceTtlMs: number;
  /** On SIGTERM, wait this long for sockets to close before exiting. */
  drainTimeoutMs: number;
  maxFrameBytes: number;
  /** New connections per IP per minute. */
  connectionsPerMinute: number;
  /** Per-connection message token bucket. */
  messageBurst: number;
  messagesPerSecond: number;
  /** Failed Pi registrations per IP per minute before that IP is blocked. */
  registrationFailuresPerMinute: number;
  registrationBlockMs: number;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env, 'PORT', 8080),
    maxPhonesPerIp: int(env, 'MAX_PHONES_PER_IP', 20),
    logLevel: (env.LOG_LEVEL as LogLevel) || 'info',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    pingIntervalMs: 30_000,
    authTimeoutMs: 10_000,
    nonceTtlMs: 30_000,
    drainTimeoutMs: 8_000,
    maxFrameBytes: MAX_SIGNAL_FRAME_BYTES,
    connectionsPerMinute: 30,
    messageBurst: 20,
    messagesPerSecond: 5,
    registrationFailuresPerMinute: 5,
    registrationBlockMs: 5 * 60_000,
    ...overrides,
  };
}
