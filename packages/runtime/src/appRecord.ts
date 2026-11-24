/**
 * The in-memory record PiFi keeps for each registered app (spec §12), plus the
 * small pure helpers around it.
 *
 * State machine:
 *
 *   stopped --start--> starting --ready--> running --stop--> stopping --exit--> stopped
 *                         |                   |
 *                         +---- unexpected exit ----> crashed --(restart allowed)--> starting
 *                                                        |
 *                                                        +--(limit hit / timeout / bad hash / no RAM)--> failed
 */
import type { ChildProcess } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { WebSocket } from 'ws';
import type { Manifest } from './registry.js';
import { Router } from './router.js';
import type { AppStreams } from './appStreams.js';

export type AppState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'failed';

/** Resolve/reject handles for "wait until the app is ready". */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // The caller might not be awaiting (e.g. an automatic restart); don't let that crash Node.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface AppRecord {
  name: string;
  manifest: Manifest;
  dir: string;
  state: AppState;
  pid?: number;
  port?: number;
  /** Per-launch secret. NEVER logged or returned by any API. */
  token?: string;
  startedAt?: number;
  /** Timestamps of recent automatic restarts (for the "max N per window" rule). */
  restartTimes: number[];
  /** Lifetime count of automatic restarts, shown in `pifi list`. */
  restartCount: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  failReason?: string;
  ws?: WebSocket;
  /** Declared in the app's hello (e.g. "streams"); reset per connection. */
  capabilities: Set<string>;
  /** Open byte streams with this app (only if it declared "streams"). */
  streams?: AppStreams;
  /** Who currently wants this app's socket paused (backpressure from slow phones). */
  pausedBy: Set<string>;
  router: Router;
  logTail: string[];

  // ---- internals used only by AppManager ----
  child?: ChildProcess;
  /** Settles when the current launch reaches `ready` (or fails). */
  ready?: Deferred<void>;
  /** True once someone asked us to stop, so the coming exit is not treated as a crash. */
  stopRequested: boolean;
  /** Set when PiFi itself killed the app for a reason (e.g. start timeout) -> final state `failed`. */
  killReason?: { code: 'START_TIMEOUT'; message: string };
  startTimer?: NodeJS.Timeout;
  stopTimers: NodeJS.Timeout[];
  restartTimer?: NodeJS.Timeout;
  exitWaiters: Array<() => void>;
  logStream?: WriteStream;
}

export function newRecord(manifest: Manifest, dir: string): AppRecord {
  return {
    name: manifest.name,
    manifest,
    dir,
    state: 'stopped',
    restartTimes: [],
    restartCount: 0,
    router: new Router(),
    capabilities: new Set(),
    pausedBy: new Set(),
    logTail: [],
    stopRequested: false,
    stopTimers: [],
    exitWaiters: [],
  };
}

/** What the API shows for an app. Notably does NOT include the token. */
export interface AppInfo {
  name: string;
  version: string;
  description?: string;
  displayName?: string;
  /** The app's own static web page (shown inside the shell's sandboxed frame). */
  frontend?: string;
  state: AppState;
  pid?: number;
  port?: number;
  uptimeMs?: number;
  restarts: number;
  memoryMB: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
  failReason?: string;
}

export function toInfo(rec: AppRecord, now = Date.now()): AppInfo {
  return {
    name: rec.name,
    version: rec.manifest.version,
    description: rec.manifest.description,
    displayName: rec.manifest.displayName,
    frontend: rec.manifest.frontend,
    state: rec.state,
    pid: rec.pid,
    port: rec.port,
    uptimeMs: rec.state === 'running' && rec.startedAt ? now - rec.startedAt : undefined,
    restarts: rec.restartCount,
    memoryMB: rec.manifest.memoryMB,
    lastExit: rec.lastExit,
    failReason: rec.failReason,
  };
}

/** Replace the `{{PORT}}` placeholder in manifest args. */
export function substitutePort(args: readonly string[], port: number | undefined): string[] {
  return args.map((arg) => (port === undefined ? arg : arg.split('{{PORT}}').join(String(port))));
}
