/**
 * The app manager: starts, stops, restarts and watches app processes (spec §12).
 *
 * The one idea that keeps this file understandable: the child process's `exit`
 * event is the ONLY place that decides what state an app ends up in. Everything
 * else (stop(), the start timeout, ...) just sets a flag explaining *why* we
 * expect an exit, then waits for it. That way a process can't be both "stopped"
 * and still alive.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { encode, PROTOCOL_VERSION, STREAMS_CAPABILITY, CloseCode, type AppMessage } from '@pifi/protocol';
import { AppStreams, DEFAULT_APP_STREAM_OPTIONS, type AppStreamHandle, type AppStreamOptions, type StreamEndpoint } from './appStreams.js';
import type { Config } from './config.js';
import { PifiError } from './errors.js';
import type { Logger } from './logger.js';
import { allocatePort } from './ports.js';
import { hashDirectory, type RegistryEntry } from './registry.js';
import { readRssMB, type MemoryReader, type MemoryInfo } from './resources.js';
import { deferred, newRecord, substitutePort, toInfo, type AppInfo, type AppRecord } from './appRecord.js';
import type { Desired, PidStore } from './state.js';

const LOG_TAIL_LINES = 200;

export interface AppManagerDeps {
  config: Config;
  log: Logger;
  readMemory: MemoryReader;
  /** Called when the USER asks for an app to run/stop, so the daemon can persist it. */
  onDesiredChange?: (name: string, desired: Desired) => void;
  pids?: PidStore;
  streamOptions?: Partial<AppStreamOptions>;
}

export interface StartOptions {
  /** Record this as the desired state (default true). Daemon boot and shutdown pass false. */
  persist?: boolean;
}

export class AppManager extends EventEmitter {
  /** Single source of truth for all apps, keyed by name. */
  readonly records = new Map<string, AppRecord>();
  private appUrl = '';
  private shuttingDown = false;
  /** Ports we handed to running apps, so two apps never get the same one. */
  private usedPorts = new Set<number>();
  private reservedPorts = new Set<number>();

  constructor(private deps: AppManagerDeps) {
    super();
  }

  private get config(): Config { return this.deps.config; }
  private get log(): Logger { return this.deps.log; }

  /** The WebSocket URL apps should connect to (known only after the local server is listening). */
  setAppUrl(url: string): void {
    this.appUrl = url;
  }

  /** Ports that must never be handed to apps (PiFi's own). */
  reservePorts(...ports: number[]): void {
    for (const p of ports) if (p > 0) this.reservedPorts.add(p);
  }

  // -------------------------------------------------------------------------
  // Registry sync
  // -------------------------------------------------------------------------

  /**
   * Make the in-memory records match a fresh registry scan. Running apps keep
   * running with the manifest they started with; changes apply on next start.
   */
  syncRegistry(entries: RegistryEntry[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.manifest.name);
      const existing = this.records.get(entry.manifest.name);
      if (!existing) {
        this.records.set(entry.manifest.name, newRecord(entry.manifest, entry.dir));
      } else if (!existing.child) {
        existing.manifest = entry.manifest;
        existing.dir = entry.dir;
      }
    }
    for (const [name, rec] of this.records) {
      if (!seen.has(name) && !rec.child) this.records.delete(name);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(): AppInfo[] {
    return [...this.records.values()].map((r) => toInfo(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  info(name: string): AppInfo {
    return toInfo(this.mustGet(name));
  }

  detail(name: string): AppInfo & { logTail: string[] } {
    const rec = this.mustGet(name);
    return { ...toInfo(rec), logTail: [...rec.logTail] };
  }

  /** Memory summary + per-app resident memory (Linux only). */
  async status(): Promise<{ memory: MemoryInfo; apps: Array<{ name: string; state: string; rssMB?: number }> }> {
    const memory = await this.deps.readMemory();
    const apps = await Promise.all(
      [...this.records.values()].map(async (rec) => ({
        name: rec.name,
        state: rec.state,
        rssMB: rec.pid ? await readRssMB(rec.pid) : undefined,
      })),
    );
    return { memory, apps };
  }

  private mustGet(name: string): AppRecord {
    const rec = this.records.get(name);
    if (!rec) throw new PifiError('NOT_FOUND', `no such app: ${name}`, 404);
    return rec;
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  async start(name: string, opts: StartOptions = {}): Promise<AppInfo> {
    const rec = this.mustGet(name);
    if (opts.persist !== false) this.deps.onDesiredChange?.(name, 'running');

    switch (rec.state) {
      case 'running':
        return toInfo(rec); // idempotent
      case 'starting':
        await rec.ready?.promise;
        return toInfo(rec);
      case 'stopping':
        throw new PifiError('BUSY', `${name} is stopping; try again in a moment`, 409);
      case 'crashed':
        // A restart was scheduled; the user wants it now instead of after the backoff.
        if (rec.restartTimer) clearTimeout(rec.restartTimer);
        rec.restartTimer = undefined;
        break;
      case 'failed':
        // A manual start gives the app a fresh restart budget.
        rec.restartTimes = [];
        break;
      case 'stopped':
        break;
    }
    await this.launch(rec);
    return toInfo(rec);
  }

  /** Verify -> check RAM -> allocate port -> spawn -> wait for `ready`. */
  private async launch(rec: AppRecord): Promise<void> {
    const { manifest } = rec;
    rec.failReason = undefined;
    // Claim the `starting` state BEFORE any await, so a second start() arriving while we
    // verify/check memory waits for this launch instead of launching a duplicate.
    const ready = deferred<void>();
    rec.ready = ready;
    rec.state = 'starting';

    // 1. Integrity (skipped only in dev mode)
    if (this.config.dev) {
      this.log.warn(`DEV MODE: not verifying hash of "${rec.name}"`);
    } else {
      if (!manifest.hash) return this.fail(rec, 'HASH_MISMATCH', 'manifest has no hash (required outside dev mode)');
      let actual: string;
      try {
        actual = await hashDirectory(rec.dir);
      } catch (err) {
        return this.fail(rec, 'HASH_MISMATCH', `could not hash app folder: ${err instanceof Error ? err.message : err}`);
      }
      if (actual !== manifest.hash) return this.fail(rec, 'HASH_MISMATCH', 'hash mismatch');
    }

    // 2. Memory
    const memory = await this.deps.readMemory();
    const needed = manifest.memoryMB + this.config.memMarginMB;
    if (memory.availableMB < needed) {
      return this.fail(
        rec,
        'INSUFFICIENT_MEMORY',
        `insufficient memory: ${memory.availableMB} MB available, need ${needed} MB (${manifest.memoryMB} app + ${this.config.memMarginMB} margin)`,
      );
    }

    // 3. Port (only if the app runs its own server)
    let port: number | undefined;
    if (manifest.needsPort) {
      port = await allocatePort(new Set([...this.usedPorts, ...this.reservedPorts]));
      this.usedPorts.add(port);
    }

    // 4. Fresh token: 32 random bytes, valid only for this process.
    const token = randomBytes(32).toString('hex');

    // 5. Spawn. shell:false + args array means no shell ever sees these strings.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      ...manifest.env,
      // PIFI_* go last so a manifest can never override them.
      PIFI_URL: this.appUrl,
      PIFI_APP_NAME: rec.name,
      PIFI_APP_TOKEN: token,
    };
    if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows won't run Node without it
    if (port !== undefined) env.PORT = String(port);

    rec.token = token;
    rec.port = port;
    rec.stopRequested = false;
    rec.killReason = undefined;
    rec.logTail = [];

    let child: ChildProcess;
    try {
      child = spawn(manifest.command, substitutePort(manifest.args, port), {
        cwd: rec.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      this.cleanupAfterProcess(rec);
      return this.fail(rec, 'SPAWN_FAILED', `could not start: ${err instanceof Error ? err.message : err}`);
    }
    rec.child = child;
    rec.pid = child.pid;
    this.log.info(`starting "${rec.name}" (pid ${child.pid ?? '?'})`);
    if (child.pid !== undefined) this.deps.pids?.set(rec.name, { pid: child.pid, command: manifest.command });

    this.captureOutput(rec, child);

    child.once('error', (err) => {
      // 'error' fires (instead of 'exit') when the executable can't be started, e.g. ENOENT.
      if (child.pid === undefined) this.onExit(rec, child, null, null, `could not start "${manifest.command}": ${err.message}`);
    });
    child.once('exit', (code, signal) => this.onExit(rec, child, code, signal));

    // 6. Start timeout: no `ready` in time -> kill; onExit turns that into `failed`.
    const timeoutMs = manifest.startTimeoutMs ?? this.config.startTimeoutMs;
    rec.startTimer = setTimeout(() => {
      if (rec.child !== child || rec.state !== 'starting') return;
      this.log.error(`"${rec.name}" did not become ready within ${timeoutMs} ms; killing it`);
      rec.killReason = { code: 'START_TIMEOUT', message: 'start timeout' };
      child.kill('SIGKILL');
    }, timeoutMs);

    await ready.promise;
  }

  /** Record a pre-spawn failure. Always throws. */
  private fail(rec: AppRecord, code: PifiError['code'], reason: string): never {
    rec.state = 'failed';
    rec.failReason = reason;
    this.log.error(`"${rec.name}" failed: ${reason}`);
    this.emit('stateChange', rec.name, rec.state);
    const err = new PifiError(code, `${rec.name}: ${reason}`, code === 'INSUFFICIENT_MEMORY' ? 507 : 409);
    rec.ready?.reject(err); // wake anyone who called start() while we were verifying
    rec.ready = undefined;
    throw err;
  }

  /** Send stdout/stderr lines to the in-memory ring buffer and to logs/<name>.log. */
  private captureOutput(rec: AppRecord, child: ChildProcess): void {
    const logsDir = path.join(this.config.home, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const stream = createWriteStream(path.join(logsDir, `${rec.name}.log`), { flags: 'a' });
    stream.on('error', () => undefined); // a full disk must not crash the daemon
    rec.logStream = stream;
    for (const source of [child.stdout, child.stderr]) {
      if (!source) continue;
      createInterface({ input: source }).on('line', (line) => this.appendLog(rec, line));
    }
  }

  private appendLog(rec: AppRecord, line: string): void {
    rec.logTail.push(line);
    if (rec.logTail.length > LOG_TAIL_LINES) rec.logTail.shift();
    rec.logStream?.write(`${new Date().toISOString()} ${line}\n`);
  }

  // -------------------------------------------------------------------------
  // The exit handler: the single place that decides final state
  // -------------------------------------------------------------------------

  private onExit(rec: AppRecord, child: ChildProcess, code: number | null, signal: string | null, spawnError?: string): void {
    if (rec.child !== child) return; // stale event from an older process
    rec.child = undefined;
    rec.lastExit = { code, signal, at: Date.now() };
    this.log.info(`"${rec.name}" exited (code=${code}, signal=${signal})`);
    this.cleanupAfterProcess(rec);

    const wasStopRequested = rec.stopRequested;
    rec.stopRequested = false;

    // Anyone still waiting for `ready` learns how it ended.
    const readyError = wasStopRequested
      ? new PifiError('STOPPED', `${rec.name} was stopped before it became ready`, 409)
      : rec.killReason
        ? new PifiError('START_TIMEOUT', `${rec.name} did not become ready in time`, 504)
        : new PifiError('EXITED', `${rec.name} exited before it became ready (code ${code}, signal ${signal})`, 502);

    if (wasStopRequested) {
      rec.state = 'stopped';
    } else if (rec.killReason) {
      rec.state = 'failed';
      rec.failReason = rec.killReason.message;
    } else if (spawnError) {
      rec.state = 'failed';
      rec.failReason = spawnError;
    } else {
      this.handleCrash(rec);
    }

    rec.ready?.reject(readyError);
    rec.ready = undefined;
    this.emit('stateChange', rec.name, rec.state);
    const waiters = rec.exitWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Free everything tied to one process: timers, token, port, socket, pending requests, pid file. */
  private cleanupAfterProcess(rec: AppRecord): void {
    if (rec.startTimer) clearTimeout(rec.startTimer);
    rec.startTimer = undefined;
    for (const t of rec.stopTimers) clearTimeout(t);
    rec.stopTimers = [];
    rec.token = undefined; // the token dies with the process
    if (rec.port !== undefined) this.usedPorts.delete(rec.port);
    rec.port = undefined;
    rec.pid = undefined;
    rec.startedAt = undefined;
    const ws = rec.ws;
    rec.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    rec.router.rejectAll(new PifiError('APP_EXITED', `${rec.name} exited while a request was pending`, 502));
    this.dropStreams(rec, 'app exited');
    rec.logStream?.end();
    rec.logStream = undefined;
    this.deps.pids?.remove(rec.name);
  }

  /** Unexpected exit: decide between restart and giving up. */
  private handleCrash(rec: AppRecord): void {
    rec.state = 'crashed';
    const { policy, maxRestarts, windowSec } = rec.manifest.restart;
    if (this.shuttingDown || policy === 'never') return;

    const now = Date.now();
    rec.restartTimes = rec.restartTimes.filter((t) => now - t < windowSec * 1000); // forget old crashes
    if (rec.restartTimes.length >= maxRestarts) {
      rec.state = 'failed';
      rec.failReason = `restart limit reached (${maxRestarts} in ${windowSec}s)`;
      this.log.error(`"${rec.name}" ${rec.failReason}; giving up`);
      return;
    }
    // Exponential backoff: base, 2x base, 4x base ... so a crash loop slows down.
    const delay = this.config.restartBackoffBaseMs * 2 ** rec.restartTimes.length;
    rec.restartTimes.push(now);
    rec.restartCount++;
    this.log.warn(`"${rec.name}" crashed; restarting in ${delay} ms (${rec.restartTimes.length}/${maxRestarts})`);
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = undefined;
      if (this.shuttingDown || rec.state !== 'crashed') return;
      this.launch(rec).catch((err) => this.log.error(`restart of "${rec.name}" failed: ${err instanceof Error ? err.message : err}`));
    }, delay);
  }

  // -------------------------------------------------------------------------
  // stop / restart
  // -------------------------------------------------------------------------

  async stop(name: string, opts: { hard?: boolean; persist?: boolean } = {}): Promise<AppInfo> {
    const rec = this.mustGet(name);
    if (opts.persist !== false) this.deps.onDesiredChange?.(name, 'stopped');
    await this.stopRecord(rec, opts.hard === true);
    return toInfo(rec);
  }

  async restart(name: string): Promise<AppInfo> {
    const rec = this.mustGet(name);
    await this.stopRecord(rec, false);
    return this.start(name);
  }

  private async stopRecord(rec: AppRecord, hard: boolean): Promise<void> {
    const child = rec.child;
    if (!child) {
      // Nothing is running. A crashed app waiting to restart is cancelled; failed/stopped stay as they are.
      if (rec.state === 'crashed') {
        if (rec.restartTimer) clearTimeout(rec.restartTimer);
        rec.restartTimer = undefined;
        rec.state = 'stopped';
        this.emit('stateChange', rec.name, rec.state);
      }
      return;
    }

    if (rec.state === 'stopping') {
      if (hard) child.kill('SIGKILL'); // impatient second stop: skip the polite steps
    } else {
      rec.stopRequested = true;
      rec.state = 'stopping';
      this.emit('stateChange', rec.name, rec.state);
      if (hard) child.kill('SIGKILL');
      else this.beginGracefulStop(rec, child);
    }
    await new Promise<void>((resolve) => rec.exitWaiters.push(resolve));
  }

  /**
   * Polite -> firmer -> forceful:
   *   1. send `shutdown` and give the app gracefulStopMs to exit on its own
   *   2. SIGTERM, wait sigtermWaitMs
   *   3. SIGKILL (cannot be ignored)
   * On Windows there is no real SIGTERM: child.kill() terminates immediately.
   */
  private beginGracefulStop(rec: AppRecord, child: ChildProcess): void {
    const escalateToKill = (): void => {
      rec.stopTimers.push(setTimeout(() => child.kill('SIGKILL'), this.config.sigtermWaitMs));
    };
    if (rec.ws && rec.ws.readyState === WebSocket.OPEN) {
      this.send(rec, { v: PROTOCOL_VERSION, type: 'shutdown', payload: { graceMs: this.config.gracefulStopMs, reason: 'stop requested' } });
      rec.stopTimers.push(
        setTimeout(() => {
          this.log.warn(`"${rec.name}" ignored shutdown; sending SIGTERM`);
          child.kill('SIGTERM');
          escalateToKill();
        }, this.config.gracefulStopMs),
      );
    } else {
      // No socket yet (still starting), so nobody can hear a `shutdown` message.
      child.kill('SIGTERM');
      escalateToKill();
    }
  }

  /** Stop every app (daemon shutdown). Does NOT change desired state, so apps return after a reboot. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.records.values()].map((rec) => this.stopRecord(rec, false)));
  }

  // -------------------------------------------------------------------------
  // Requests (control API today, phone commands later)
  // -------------------------------------------------------------------------

  async request(name: string, payload: unknown, timeoutMs = this.config.requestTimeoutMs, session?: string): Promise<unknown> {
    const rec = this.mustGet(name);
    if (rec.state !== 'running' || !rec.ws || rec.ws.readyState !== WebSocket.OPEN) {
      throw new PifiError('NOT_RUNNING', `${name} is not running (state: ${rec.state})`, 409);
    }
    const { id, promise } = rec.router.create(timeoutMs);
    this.send(rec, { v: PROTOCOL_VERSION, type: 'request', id, payload, ...(session ? { session } : {}) });
    return promise;
  }

  private send(rec: AppRecord, message: Parameters<typeof encode>[0]): void {
    if (rec.ws && rec.ws.readyState === WebSocket.OPEN) rec.ws.send(encode(message));
  }

  // -------------------------------------------------------------------------
  // Hooks used by the local WebSocket server
  // -------------------------------------------------------------------------

  /** Decide whether a `hello` is acceptable. Order matters: unknown app, then token, then duplicate. */
  authenticateHello(name: string, token: string): 'ok' | 'unknown-app' | 'bad-token' | 'duplicate' {
    const rec = this.records.get(name);
    if (!rec) return 'unknown-app';
    if (!rec.token || !safeEqual(rec.token, token)) return 'bad-token';
    if (rec.ws && rec.ws.readyState === WebSocket.OPEN) return 'duplicate';
    return 'ok';
  }

  attachSocket(name: string, ws: WebSocket, capabilities: readonly string[] = []): void {
    const rec = this.mustGet(name);
    rec.ws = ws;
    rec.capabilities = new Set(capabilities);
    if (rec.capabilities.has(STREAMS_CAPABILITY)) {
      rec.streams = new AppStreams(
        name,
        {
          send: (m) => this.send(rec, m),
          sendBinary: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame); },
          bufferedAmount: () => ws.bufferedAmount,
        },
        { ...DEFAULT_APP_STREAM_OPTIONS, ...this.deps.streamOptions },
        this.log,
        (req) => this.emit('appStreamOpen', name, req),
      );
    }
    this.send(rec, { v: PROTOCOL_VERSION, type: 'welcome', payload: { name } });
  }

  onSocketClosed(name: string, ws: WebSocket): void {
    const rec = this.records.get(name);
    if (!rec || rec.ws !== ws) return;
    rec.ws = undefined;
    rec.router.rejectAll(new PifiError('APP_EXITED', `${name} disconnected while a request was pending`, 502));
    this.dropStreams(rec, 'app disconnected');
  }

  private dropStreams(rec: AppRecord, reason: string): void {
    rec.streams?.closeAll(reason);
    rec.streams = undefined;
    rec.capabilities = new Set();
    rec.pausedBy.clear();
  }

  /** Binary frames are stream data; only apps that declared "streams" may send them. */
  onAppBinary(name: string, ws: WebSocket, frame: Uint8Array): void {
    const rec = this.records.get(name);
    if (!rec || rec.ws !== ws) return;
    if (!rec.streams) return void ws.close(CloseCode.PROTOCOL_VIOLATION, 'text frames only');
    if (!rec.streams.onBinary(frame)) this.log.debug(`"${name}" sent stream data for an unknown stream`);
  }

  /** Open a byte stream to an app (e.g. a phone uploading). */
  openStream(name: string, op: string, meta: unknown, endpoint: StreamEndpoint): Promise<AppStreamHandle> {
    const rec = this.mustGet(name);
    if (rec.state !== 'running' || !rec.ws) throw new PifiError('NOT_RUNNING', `${name} is not running`, 409);
    if (!rec.streams) throw new PifiError('BAD_REQUEST', `${name} does not support streams`, 400);
    return rec.streams.open(op, meta, endpoint);
  }

  /**
   * Backpressure towards a slow phone: pause reading from the app's socket while
   * any `key` (a session) asks for it, so TCP pushes back on the app.
   */
  setPaused(name: string, key: string, paused: boolean): void {
    const rec = this.records.get(name);
    if (!rec?.ws) return;
    if (paused) rec.pausedBy.add(key);
    else rec.pausedBy.delete(key);
    if (rec.pausedBy.size > 0 && !rec.ws.isPaused) rec.ws.pause();
    if (rec.pausedBy.size === 0 && rec.ws.isPaused) rec.ws.resume();
  }

  onAppMessage(name: string, ws: WebSocket, msg: AppMessage): void {
    const rec = this.records.get(name);
    if (!rec || rec.ws !== ws) return;
    switch (msg.type) {
      case 'ready':
        if (rec.state === 'starting') {
          if (rec.startTimer) clearTimeout(rec.startTimer);
          rec.startTimer = undefined;
          rec.state = 'running';
          rec.startedAt = Date.now();
          this.log.info(`"${rec.name}" is running`);
          this.emit('stateChange', rec.name, rec.state);
          rec.ready?.resolve();
        }
        break;
      case 'response':
        if (!rec.router.settle(msg.id, { payload: msg.payload, error: msg.error })) {
          this.log.debug(`"${name}" sent a response for unknown request id (late or duplicate)`);
        }
        break;
      case 'event':
        this.emit('appEvent', name, msg.payload.name, msg.payload.data);
        break;
      case 'log':
        this.appendLog(rec, `[${msg.payload.level}] ${msg.payload.message}`);
        break;
      case 'hello':
        break; // rejected earlier by the local server
      case 'stream.open':
      case 'stream.accept':
      case 'stream.reject':
      case 'stream.end':
      case 'stream.abort':
        if (!rec.streams) return void ws.close(CloseCode.PROTOCOL_VIOLATION, 'streams not declared in hello');
        rec.streams.onMessage(msg);
        break;
    }
  }
}

/** Constant-time string comparison so response timing can't leak how much of a token matched. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
