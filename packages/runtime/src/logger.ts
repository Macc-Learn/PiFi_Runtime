/**
 * A tiny leveled logger. Deliberately dumb: it prints what it is given.
 * The rule for callers is: never pass tokens (app or admin) to it.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel, prefix = 'pifi'): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string): void => {
    if (ORDER[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${prefix}] ${message}`;
    // Warnings and errors go to stderr so they stand out when stdout is piped.
    if (lvl === 'warn' || lvl === 'error') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

export const silentLogger: Logger = createLogger('silent');
