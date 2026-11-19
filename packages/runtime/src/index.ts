/**
 * Daemon entry point and public library surface.
 *
 * `runDaemon()` is what `pifi daemon` calls: it starts everything and turns
 * SIGINT/SIGTERM (Ctrl+C, `systemctl stop`) into a graceful shutdown that stops
 * all child apps before exiting.
 */
import { Daemon } from './daemon.js';
import type { Config } from './config.js';

export { Daemon, VERSION } from './daemon.js';
export { loadConfig, type Config } from './config.js';
export { AppManager } from './appManager.js';
export { loadRegistry, hashDirectory, ManifestSchema, type Manifest } from './registry.js';
export { PifiError } from './errors.js';

export async function runDaemon(config: Config): Promise<Daemon> {
  const daemon = new Daemon({ config });
  await daemon.start();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return; // a second Ctrl+C while stopping is ignored; stop() already escalates on its own
    stopping = true;
    daemon.log.info(`received ${signal}`);
    daemon.stop().then(
      () => process.exit(0),
      (err) => {
        daemon.log.error(`shutdown error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return daemon;
}
