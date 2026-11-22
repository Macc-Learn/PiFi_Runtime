/**
 * In-memory rate limiting (Phase 2 §8). Per source IP:
 *   - new connections: token bucket
 *   - failed Pi registrations: count per minute, then block the IP for a while
 * and per connection: a message token bucket (created by wsHandler).
 *
 * IPs live only in these maps and are swept away once idle, never persisted.
 */

/**
 * Classic token bucket: holds up to `capacity` tokens, refills at `refillPerSec`.
 * Each action takes one token; an empty bucket means "too fast".
 * capacity = burst size, refill rate = sustained rate.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Full again = nothing worth remembering about this IP. */
  isFull(): boolean {
    const t = this.now();
    return this.tokens + ((t - this.last) / 1000) * this.refillPerSec >= this.capacity;
  }
}

interface IpEntry {
  connections: TokenBucket;
  failures: number[];
  blockedUntil?: number;
}

export interface IpRateLimitConfig {
  connectionsPerMinute: number;
  registrationFailuresPerMinute: number;
  registrationBlockMs: number;
}

export class IpRateLimiter {
  private entries = new Map<string, IpEntry>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly cfg: IpRateLimitConfig, private readonly now: () => number = Date.now) {}

  private entry(ip: string): IpEntry {
    let e = this.entries.get(ip);
    if (!e) {
      e = { connections: new TokenBucket(this.cfg.connectionsPerMinute, this.cfg.connectionsPerMinute / 60, this.now), failures: [] };
      this.entries.set(ip, e);
    }
    return e;
  }

  allowConnection(ip: string): boolean {
    return this.entry(ip).connections.take();
  }

  isRegistrationBlocked(ip: string): boolean {
    const e = this.entries.get(ip);
    return e?.blockedUntil !== undefined && this.now() < e.blockedUntil;
  }

  recordRegistrationFailure(ip: string): void {
    const e = this.entry(ip);
    const t = this.now();
    e.failures = e.failures.filter((f) => t - f < 60_000);
    e.failures.push(t);
    if (e.failures.length >= this.cfg.registrationFailuresPerMinute) {
      e.blockedUntil = t + this.cfg.registrationBlockMs;
      e.failures = [];
    }
  }

  /** Forget IPs that have nothing left to remember. */
  sweep(): void {
    const t = this.now();
    for (const [ip, e] of this.entries) {
      e.failures = e.failures.filter((f) => t - f < 60_000);
      if (e.blockedUntil !== undefined && t >= e.blockedUntil) e.blockedUntil = undefined;
      if (e.failures.length === 0 && e.blockedUntil === undefined && e.connections.isFull()) this.entries.delete(ip);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  startSweeping(intervalMs = 60_000): void {
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }
}
