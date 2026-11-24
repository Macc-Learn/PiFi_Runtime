/**
 * The Daemon wires every part together: registry, app manager, local WebSocket
 * server, control API and persisted state. It is a class (not a script) so the
 * tests can start and stop whole daemons in-process.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppManager } from './appManager.js';
import type { Config } from './config.js';
import { ControlApi, loadOrCreateAdminToken } from './controlApi.js';
import { createLogger, type Logger } from './logger.js';
import { LocalServer } from './localServer.js';
import { loadRegistry, registeredAppsDir } from './registry.js';
import { createMemoryReader, type MemoryReader } from './resources.js';
import { killStalePids, PidStore, StateStore } from './state.js';
import { loadOrCreateIdentity, type Identity } from './identity.js';
import { PairingManager } from './pairing.js';
import { SignalingClient, type RelayMessage, type SignalingClientOptions, type SignalingState } from './signalingClient.js';
import { decodeRelayBody, encodeRelayBody, PhoneToPiBodySchema, type PhoneToPiBody, type PiToPhoneBody } from '@pifi/protocol';
import { PairedStore } from './pairedStore.js';
import { PairHandler } from './pairHandler.js';
import { NdcPeerTransport, shutdownPeerLibrary, type PeerTransportFactory } from './peer.js';
import { SessionManager } from './sessions.js';

export const VERSION = '0.1.0';

export interface DaemonOptions {
  config: Config;
  log?: Logger;
  /** Tests inject a fake memory reader to simulate a Pi that is out of RAM. */
  readMemory?: MemoryReader;
  /** Tests tweak signaling timings/clock/randomness here. */
  signaling?: Partial<Omit<SignalingClientOptions, 'identity' | 'log'>>;
  /** Tests swap in FakePeerTransport here. */
  transportFactory?: PeerTransportFactory;
  /** Phone -> app request timeout (default 30 s). */
  appRequestTimeoutMs?: number;
}

export class Daemon {
  readonly config: Config;
  readonly log: Logger;
  readonly manager: AppManager;
  readonly state: StateStore;
  readonly pids: PidStore;
  private localServer: LocalServer;
  private controlApi?: ControlApi;
  private adminToken = '';
  private startedAt = Date.now();
  private _identity?: Identity;
  private signaling?: SignalingClient;
  private readonly signalingOverrides: DaemonOptions['signaling'];
  /** Pairing codes live in daemon memory only. */
  readonly pairing: PairingManager;
  readonly paired: PairedStore;
  private _sessions?: SessionManager;
  private pairHandler?: PairHandler;
  private readonly transportFactory: PeerTransportFactory;
  private readonly appRequestTimeoutMs?: number;

  constructor(opts: DaemonOptions) {
    this.config = opts.config;
    this.log = opts.log ?? createLogger(opts.config.logLevel);
    this.state = new StateStore(this.config.home, this.log);
    this.pids = new PidStore(this.config.home, this.log);
    this.manager = new AppManager({
      config: this.config,
      log: this.log,
      readMemory: opts.readMemory ?? createMemoryReader(this.log),
      pids: this.pids,
      // Persist user intent ("I want this running") so it survives reboots.
      onDesiredChange: (name, desired) => { void this.state.set(name, desired); },
    });
    this.localServer = new LocalServer(this.config, this.manager, this.log);
    this.pairing = new PairingManager({ defaultTtlSec: this.config.pairTtlSec });
    this.signalingOverrides = opts.signaling;
    this.paired = new PairedStore(this.config.home, this.config.maxPairedPhones, this.log);
    this.transportFactory = opts.transportFactory ?? (() => new NdcPeerTransport());
    this.appRequestTimeoutMs = opts.appRequestTimeoutMs;
  }

  get sessions(): SessionManager {
    if (!this._sessions) throw new Error('daemon not started');
    return this._sessions;
  }

  /** What the shell's `status` control op shows. */
  private async deviceStatus(): Promise<Record<string, unknown>> {
    const s = await this.manager.status();
    return {
      deviceId: this.identity.deviceId,
      deviceName: this.config.deviceName,
      version: VERSION,
      memoryAvailableMB: s.memory.availableMB,
      runningApps: s.apps.filter((a) => a.state === 'running').length,
    };
  }

  /**
   * A relay from a phone (via the signaling server). Decoded and validated here;
   * anything that isn't a known body is dropped. Bodies are never logged.
   */
  private async onRelay({ peerId, payload }: RelayMessage): Promise<void> {
    const body = decodeRelayBody(PhoneToPiBodySchema, payload);
    if (!body) return;
    const reply = await this.handlePhoneBody(peerId, body);
    this.signaling?.relay(peerId, encodeRelayBody(reply));
  }

  /** Answer one validated phone body (pairing or session handshake). Public for tests. */
  async handlePhoneBody(peerId: string, body: PhoneToPiBody): Promise<PiToPhoneBody> {
    if (!this._sessions || !this.pairHandler) throw new Error('daemon not started');
    switch (body.k) {
      case 'pair.request':
        return this.pairHandler.handle(body);
      case 'session.hello':
        return this._sessions.hello(peerId, body.phoneId, body.np);
      case 'session.offer':
        return this._sessions.offer(peerId, body.sdp, body.sig);
    }
  }

  get identity(): Identity {
    if (!this._identity) throw new Error('daemon not started');
    return this._identity;
  }

  signalingState(): SignalingState {
    return this.signaling?.getState() ?? { state: 'disabled', since: this.startedAt, url: this.config.signalUrl };
  }

  /** The live client (tests listen to its events). */
  get signalingClient(): SignalingClient | undefined {
    return this.signaling;
  }

  get appPort(): number { return this.localServer.port; }
  get controlPort(): number { return this.controlApi?.port ?? 0; }

  async start(): Promise<void> {
    const { home } = this.config;
    await mkdir(registeredAppsDir(home), { recursive: true });
    await mkdir(path.join(home, 'logs'), { recursive: true });
    if (this.config.dev) this.log.warn('DEV MODE: app hashes will NOT be verified');

    this.adminToken = await loadOrCreateAdminToken(home);
    // Refuses to start (throws) if the key pair is incomplete or mismatched; never regenerates silently.
    this._identity = await loadOrCreateIdentity(home, this.log);
    await this.paired.load();
    this.pairHandler = new PairHandler(this._identity, this.pairing, this.paired, this.log);
    this._sessions = new SessionManager({
      identity: this._identity,
      paired: this.paired,
      manager: this.manager,
      transportFactory: this.transportFactory,
      iceServers: this.config.iceServers,
      maxSessions: this.config.maxSessions,
      idleMs: this.config.sessionIdleSec * 1000,
      log: this.log,
      status: () => this.deviceStatus(),
      appRequestTimeoutMs: this.appRequestTimeoutMs,
    });
    await killStalePids(this.pids, this.log);
    await this.state.load();
    await this.reload();

    const appPort = await this.localServer.listen();
    this.manager.setAppUrl(`ws://127.0.0.1:${appPort}/app`);

    this.startedAt = Date.now();
    this.controlApi = new ControlApi(
      this.config,
      this.manager,
      this.adminToken,
      {
        reload: () => this.reload(),
        startedAt: this.startedAt,
        version: VERSION,
        identity: this._identity,
        pairing: this.pairing,
        signalingState: () => this.signalingState(),
        phones: () => this.sessions.listPhones(),
        revokePhone: (query) => {
          const phone = this.paired.resolve(query);
          this.sessions.revoke(phone.phoneId);
          return phone.phoneId;
        },
        sessionCount: () => this.sessions.count,
      },
      this.log,
    );
    const controlPort = await this.controlApi.listen();
    // PiFi's own ports must never be handed to an app.
    this.manager.reservePorts(appPort, controlPort);

    // Signaling starts last and never blocks: start() only schedules the first connection,
    // so an unreachable server cannot prevent the daemon or apps from running.
    this.signaling = new SignalingClient({
      url: this.config.signalUrl,
      identity: this._identity,
      log: this.log,
      dev: this.config.dev,
      pingMs: this.config.signalPingMs,
      backoffMinMs: this.config.signalBackoffMinMs,
      backoffMaxMs: this.config.signalBackoffMaxMs,
      ...this.signalingOverrides,
    });
    this.signaling.on('relay', (m: RelayMessage) => {
      this.onRelay(m).catch((err) => this.log.error(`relay handling failed: ${err instanceof Error ? err.message : err}`));
    });
    this.signaling.start();

    await this.autostart();
  }

  /** Re-scan registered-apps/. Bad manifests are reported but never stop the others. */
  async reload(): Promise<{ apps: number; errors: Array<{ dir: string; error: string }> }> {
    const scan = await loadRegistry(this.config.home, { dev: this.config.dev });
    for (const e of scan.errors) this.log.error(`skipping ${path.basename(e.dir)}: ${e.error}`);
    this.manager.syncRegistry(scan.entries);
    this.log.info(`registry: ${scan.entries.length} app(s) loaded, ${scan.errors.length} rejected`);
    return { apps: scan.entries.length, errors: scan.errors };
  }

  /**
   * Boot-time start. An explicit desired state wins (if you stopped an autostart app
   * on purpose, a reboot should respect that); otherwise the manifest's `autostart` decides.
   */
  private async autostart(): Promise<void> {
    for (const rec of this.manager.records.values()) {
      const desired = this.state.get(rec.name);
      const shouldRun = desired ? desired === 'running' : rec.manifest.autostart;
      if (!shouldRun) continue;
      this.manager.start(rec.name, { persist: false }).catch((err) => {
        this.log.error(`autostart of "${rec.name}" failed: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /** Graceful shutdown: stop all children, then the servers. Desired state is left untouched. */
  async stop(): Promise<void> {
    this.log.info('shutting down: stopping all apps');
    this._sessions?.closeAll();
    await this.signaling?.stop();
    await this.manager.stopAll();
    await this.controlApi?.close();
    await this.localServer.close();
    await this.state.flush();
    await this.pids.flush();
    await this.paired.flush();
    shutdownPeerLibrary();
  }
}
