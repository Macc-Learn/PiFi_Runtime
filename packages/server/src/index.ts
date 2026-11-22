#!/usr/bin/env node
/**
 * Entry point: `node dist/src/index.js`. Reads config from the environment,
 * starts the server, and on SIGTERM (Cloud Run's "you're being replaced")
 * shuts down gracefully: every client gets close code 4100 = "reconnect soon".
 */
import { createLogger } from './logger.js';
import { createSignalingServer, loadServerConfig } from './server.js';

const cfg = loadServerConfig();
const log = createLogger(cfg.logLevel);
const server = createSignalingServer(cfg, { log });

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info('received signal', { signal });
  try {
    await server.shutdown();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

server.listen().catch((err) => {
  log.error('could not start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
