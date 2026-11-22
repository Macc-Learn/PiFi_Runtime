/**
 * Builds a complete signaling server (HTTP + WebSocket + presence + rate limits)
 * without starting it, so tests can run many in one process.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { SignalCloseCode } from '@pifi/protocol';
import type { ServerConfig } from './config.js';
import { clientIp, handleHttp, rejectUpgrade } from './http.js';
import { createLogger, type Logger } from './logger.js';
import { InMemoryPresenceStore } from './presence/InMemoryPresenceStore.js';
import type { PresenceStore } from './presence/PresenceStore.js';
import { IpRateLimiter } from './rateLimit.js';
import { SignalingHub } from './wsHandler.js';

export { loadServerConfig, type ServerConfig } from './config.js';
export { createLogger, maskIp, shortId, type Logger } from './logger.js';
export { InMemoryPresenceStore } from './presence/InMemoryPresenceStore.js';
export type { PiConnection, PresenceStore } from './presence/PresenceStore.js';
export { TokenBucket, IpRateLimiter } from './rateLimit.js';

export interface SignalingServer {
  readonly port: number;
  readonly presence: PresenceStore;
  readonly hub: SignalingHub;
  listen(): Promise<number>;
  /** Graceful: refuse new connections, close all with 4100, wait for drain, then stop. */
  shutdown(): Promise<void>;
}

export function createSignalingServer(
  cfg: ServerConfig,
  deps: { presence?: PresenceStore; log?: Logger; now?: () => number } = {},
): SignalingServer {
  const log = deps.log ?? createLogger(cfg.logLevel);
  const presence = deps.presence ?? new InMemoryPresenceStore();
  const limiter = new IpRateLimiter(cfg, deps.now);
  const hub = new SignalingHub(cfg, presence, limiter, log, deps.now);
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes });
  const httpServer = http.createServer(handleHttp);
  let shuttingDown = false;
  let port = 0;

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/ws') return rejectUpgrade(socket, 404);
    if (shuttingDown) return rejectUpgrade(socket, 503);
    wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws, clientIp(req, cfg.trustProxy)));
  });

  return {
    get port() { return port; },
    presence,
    hub,
    listen: () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(cfg.port, cfg.host, () => {
          const addr = httpServer.address();
          port = typeof addr === 'object' && addr ? addr.port : cfg.port;
          hub.startKeepalive();
          limiter.startSweeping();
          log.info('signaling server listening', { port });
          resolve(port);
        });
      }),
    shutdown: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info('shutting down: closing all connections with 4100', { connections: hub.connections.size });
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      hub.closeAll(SignalCloseCode.SERVER_RESTARTING, 'server restarting');
      const deadline = Date.now() + cfg.drainTimeoutMs;
      while (hub.connections.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      hub.terminateAll(); // whoever is still around after the drain window
      hub.stopKeepalive();
      limiter.stop();
      httpServer.closeAllConnections();
      await closed;
    },
  };
}
