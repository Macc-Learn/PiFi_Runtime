/**
 * Paired phones, on disk (Phase 3 §5.1): ${PIFI_HOME}/paired.json, mode 0600,
 * written atomically. Holds PUBLIC keys only; nothing here is secret, but it
 * decides who may control the Pi, so it is still owner-only.
 *
 *   { "v": 1, "phones": [ { phoneId, spki, label, createdAt, lastSeenAt } ] }
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEVICE_ID_REGEX } from '@pifi/protocol';
import type { Logger } from './logger.js';
import { writeJsonAtomic } from './state.js';

export interface PairedPhone {
  phoneId: string;
  /** base64url SPKI DER of the phone's public key for THIS Pi. */
  spki: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
}

const FileSchema = z.object({
  v: z.literal(1),
  phones: z.array(z.object({
    phoneId: z.string().regex(DEVICE_ID_REGEX),
    spki: z.string().regex(/^[A-Za-z0-9_-]+$/),
    label: z.string().max(40),
    createdAt: z.number(),
    lastSeenAt: z.number(),
  })),
});

export class PairedStore {
  private phones = new Map<string, PairedPhone>();
  private chain: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(home: string, readonly max: number, private readonly log: Logger) {
    this.file = path.join(home, 'paired.json');
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return; // nothing paired yet
    }
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Refuse to guess: a corrupt file must not silently unpair or re-pair anyone.
      throw new Error(`${this.file} is corrupt; fix or remove it (removing it unpairs every phone)`);
    }
    for (const p of parsed.data.phones) this.phones.set(p.phoneId, p);
  }

  list(): PairedPhone[] {
    return [...this.phones.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(phoneId: string): PairedPhone | undefined {
    return this.phones.get(phoneId);
  }

  get size(): number {
    return this.phones.size;
  }

  isFull(): boolean {
    return this.phones.size >= this.max;
  }

  /** Add (or re-add) a phone. Returns false if the store is full. */
  add(phone: Omit<PairedPhone, 'createdAt' | 'lastSeenAt'>, now = Date.now()): boolean {
    if (!this.phones.has(phone.phoneId) && this.isFull()) return false;
    this.phones.set(phone.phoneId, { ...phone, createdAt: now, lastSeenAt: now });
    this.log.info(`paired phone ${phone.phoneId.slice(0, 8)}… ("${phone.label}")`);
    void this.save();
    return true;
  }

  remove(phoneId: string): boolean {
    const had = this.phones.delete(phoneId);
    if (had) {
      this.log.info(`revoked phone ${phoneId.slice(0, 8)}…`);
      void this.save();
    }
    return had;
  }

  touch(phoneId: string, now = Date.now()): void {
    const p = this.phones.get(phoneId);
    if (!p) return;
    p.lastSeenAt = now;
    void this.save();
  }

  /**
   * Find one phone by a unique phoneId prefix (>= 6 chars) or by exact label.
   * Throws a readable error for "none" or "ambiguous".
   */
  resolve(query: string): PairedPhone {
    const byPrefix = query.length >= 6 ? this.list().filter((p) => p.phoneId.startsWith(query)) : [];
    const byLabel = this.list().filter((p) => p.label === query);
    const matches = byPrefix.length > 0 ? byPrefix : byLabel;
    if (matches.length === 0) throw new Error(query.length < 6 && byLabel.length === 0 ? 'give at least 6 characters of the phone ID, or its exact label' : 'no paired phone matches');
    if (matches.length > 1) throw new Error('more than one paired phone matches; give a longer prefix');
    return matches[0] as PairedPhone;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private save(): Promise<void> {
    const snapshot = { v: 1, phones: this.list() };
    this.chain = this.chain
      .then(() => writeJsonAtomic(this.file, snapshot, 0o600))
      .catch((err) => this.log.error(`could not save paired.json: ${err instanceof Error ? err.message : err}`));
    return this.chain;
  }
}
