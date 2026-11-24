/**
 * Pairing codes (Phase 1 revision §3.4).
 *
 * A pairing code is a one-time secret the Pi shows as a QR. Whoever scans it
 * within the TTL proves they had physical/SSH access to the Pi.
 *
 * Rules:
 *  - only one active code; creating a new one replaces the old
 *  - the plaintext secret lives ONLY in this object's memory: never on disk,
 *    never logged, returned exactly once (by create())
 *  - why plaintext and not a hash: in Phase 3 the phone proves knowledge with
 *    HMAC(key = secret, ...), so the Pi must hold the key to recompute it
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pairProof } from '@pifi/protocol';
import { PifiError } from './errors.js';

export const MAX_PAIR_TTL_SEC = 3600;
/** Wrong proofs allowed before the code is burned (stops guessing). */
export const MAX_PAIR_FAILURES = 5;

export interface PairingCode {
  secret: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  ttlSec: number;
}

export interface PairingStatus {
  active: boolean;
  expiresAt?: number;
}

export class PairingManager {
  // A true private field (#): not visible to JSON.stringify, util.inspect or Object.keys.
  #active: { secret: string; expiresAt: number; failures: number } | undefined;
  #wipeTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly defaultTtlSec: number;

  constructor(opts: { defaultTtlSec?: number; now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.defaultTtlSec = opts.defaultTtlSec ?? 600;
  }

  create(ttlSec: number = this.defaultTtlSec): PairingCode {
    if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_PAIR_TTL_SEC) {
      throw new PifiError('BAD_REQUEST', `ttlSec must be an integer between 1 and ${MAX_PAIR_TTL_SEC}`, 400);
    }
    this.revoke(); // only one active code
    const secret = randomBytes(16).toString('base64url'); // 128 bits, 22 chars
    const expiresAt = this.now() + ttlSec * 1000;
    this.#active = { secret, expiresAt, failures: 0 };
    // Also wipe it from memory on time, not only when someone next asks.
    this.#wipeTimer = setTimeout(() => this.revoke(), ttlSec * 1000);
    this.#wipeTimer.unref();
    return { secret, expiresAt, ttlSec };
  }

  /** Never includes the secret. */
  status(): PairingStatus {
    const code = this.current();
    return code ? { active: true, expiresAt: code.expiresAt } : { active: false };
  }

  revoke(): void {
    this.#active = undefined;
    if (this.#wipeTimer) clearTimeout(this.#wipeTimer);
    this.#wipeTimer = undefined;
  }

  /**
   * Check a phone's pairing proof (Phase 3 §4.2):
   *   proof == HMAC-SHA256(key = secret, "pifi-pair-v1" || deviceId || phoneSpki)
   * Constant-time compare. Success BURNS the code (single use). Every failure
   * counts; after MAX_PAIR_FAILURES the code is revoked so it can't be brute-forced.
   */
  verifyProof(deviceId: string, phoneSpki: Uint8Array, proof: Uint8Array): boolean {
    const code = this.current();
    if (!code) return false;
    const expected = pairProof(code.secret, deviceId, phoneSpki);
    const ok = proof.length === expected.length && timingSafeEqual(Buffer.from(proof), expected);
    if (ok) this.revoke();
    else this.noteFailure();
    return ok;
  }

  /** Count a failed attempt that never reached verifyProof (e.g. a malformed key). */
  noteFailure(): void {
    const code = this.current();
    if (!code) return;
    code.failures++;
    if (code.failures >= MAX_PAIR_FAILURES) this.revoke();
  }

  /** Constant-time check, kept so secrets are never compared with ===. */
  protected matches(candidate: string): boolean {
    const code = this.current();
    if (!code) return false;
    const a = Buffer.from(code.secret);
    const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private current(): { secret: string; expiresAt: number; failures: number } | undefined {
    if (this.#active && this.now() >= this.#active.expiresAt) this.revoke();
    return this.#active;
  }

  toJSON(): PairingStatus {
    return this.status();
  }
}
