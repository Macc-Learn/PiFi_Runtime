/**
 * JSON-lines logger (Cloud Run turns `severity` into log levels automatically).
 *
 * Privacy rules enforced by convention here and checked by tests:
 *  - never log payloads, signatures, nonces or keys
 *  - deviceIds only as their first 8 characters (shortId)
 *  - IPs only masked (maskIp)
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const threshold = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void => {
    if (ORDER[lvl] < threshold) return;
    sink(JSON.stringify({ severity: lvl.toUpperCase(), time: new Date().toISOString(), message, ...fields }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** First 8 characters: enough to tell Pis apart in logs, not enough to target one. */
export function shortId(deviceId: string | undefined): string | undefined {
  return deviceId ? `${deviceId.slice(0, 8)}…` : undefined;
}

/** 203.0.113.7 -> 203.0.x.x ; 2001:db8:1:2::5 -> 2001:db8:… */
export function maskIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  const parts = ip.split(':').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}:…` : 'unknown';
}
