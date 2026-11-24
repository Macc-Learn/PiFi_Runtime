/**
 * Where the shell keeps its state (Phase 3 §9.3): IndexedDB database `pifi`.
 *
 *   pis               { deviceId, piSpki, label, keyPair, phoneId, createdAt, lastUsedAt }
 *   trustedFrontends  { deviceId, app, origin }
 *
 * keyPair holds CryptoKey objects. IndexedDB stores them by structured clone,
 * which keeps a non-extractable private key non-extractable: the page can sign
 * with it after a reload, but can never read the key bytes.
 */
import { ShellError } from './errors.js';

export interface PiRecord {
  deviceId: string;
  /** base64url SPKI of the Pi's identity key (checked against deviceId at pairing). */
  piSpki: string;
  /** This phone's label as the Pi knows it. */
  label: string;
  keyPair: CryptoKeyPair;
  phoneId: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface TrustedFrontend {
  deviceId: string;
  app: string;
  origin: string;
}

export interface ShellStore {
  listPis(): Promise<PiRecord[]>;
  getPi(deviceId: string): Promise<PiRecord | undefined>;
  putPi(rec: PiRecord): Promise<void>;
  deletePi(deviceId: string): Promise<void>;
  getTrusted(deviceId: string, app: string): Promise<TrustedFrontend | undefined>;
  putTrusted(t: TrustedFrontend): Promise<void>;
}

/** A stored record whose key is gone or unusable -> KEY_MISSING (offer re-pair; never crash). */
export function checkKey(rec: PiRecord): void {
  const k = rec.keyPair as Partial<CryptoKeyPair> | undefined;
  const ok = !!k && typeof k === 'object' && !!k.privateKey && !!k.publicKey
    && typeof (k.privateKey as CryptoKey).type === 'string' && (k.privateKey as CryptoKey).type === 'private';
  if (!ok) throw new ShellError('KEY_MISSING', 'The key for this Pi is missing on this phone.');
}

export class MemoryStore implements ShellStore {
  readonly pis = new Map<string, PiRecord>();
  readonly trusted = new Map<string, TrustedFrontend>();
  async listPis(): Promise<PiRecord[]> { return [...this.pis.values()]; }
  async getPi(id: string): Promise<PiRecord | undefined> { return this.pis.get(id); }
  async putPi(rec: PiRecord): Promise<void> { this.pis.set(rec.deviceId, rec); }
  async deletePi(id: string): Promise<void> {
    this.pis.delete(id);
    for (const [k, t] of this.trusted) if (t.deviceId === id) this.trusted.delete(k);
  }
  async getTrusted(deviceId: string, app: string): Promise<TrustedFrontend | undefined> { return this.trusted.get(`${deviceId}/${app}`); }
  async putTrusted(t: TrustedFrontend): Promise<void> { this.trusted.set(`${t.deviceId}/${t.app}`, t); }
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class IndexedDbStore implements ShellStore {
  private constructor(private readonly db: IDBDatabase) {}

  /** Fails with STORAGE_UNAVAILABLE (e.g. private browsing, storage disabled). */
  static async open(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<IndexedDbStore> {
    if (!idb) throw new ShellError('STORAGE_UNAVAILABLE');
    try {
      const open = idb.open('pifi', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('pis')) db.createObjectStore('pis', { keyPath: 'deviceId' });
        if (!db.objectStoreNames.contains('trustedFrontends')) db.createObjectStore('trustedFrontends', { keyPath: ['deviceId', 'app'] });
      };
      return new IndexedDbStore(await req(open));
    } catch {
      throw new ShellError('STORAGE_UNAVAILABLE');
    }
  }

  private store(name: 'pis' | 'trustedFrontends', mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async listPis(): Promise<PiRecord[]> { return req(this.store('pis', 'readonly').getAll()) as Promise<PiRecord[]>; }
  async getPi(id: string): Promise<PiRecord | undefined> { return req(this.store('pis', 'readonly').get(id)) as Promise<PiRecord | undefined>; }
  async putPi(rec: PiRecord): Promise<void> { await req(this.store('pis', 'readwrite').put(rec)); }
  async deletePi(id: string): Promise<void> {
    await req(this.store('pis', 'readwrite').delete(id));
    const all = (await req(this.store('trustedFrontends', 'readonly').getAll())) as TrustedFrontend[];
    for (const t of all.filter((x) => x.deviceId === id)) await req(this.store('trustedFrontends', 'readwrite').delete([t.deviceId, t.app]));
  }
  async getTrusted(deviceId: string, app: string): Promise<TrustedFrontend | undefined> {
    return req(this.store('trustedFrontends', 'readonly').get([deviceId, app])) as Promise<TrustedFrontend | undefined>;
  }
  async putTrusted(t: TrustedFrontend): Promise<void> { await req(this.store('trustedFrontends', 'readwrite').put(t)); }
}

/**
 * First-use consent (§10.3), keyed by Pi + app + ORIGIN of the front-end URL.
 * If the Pi later reports a different origin for the same app, ask again.
 */
export async function needsConsent(store: ShellStore, deviceId: string, app: string, frontend: string): Promise<boolean> {
  const origin = new URL(frontend).origin;
  const t = await store.getTrusted(deviceId, app);
  return !t || t.origin !== origin;
}

export async function recordConsent(store: ShellStore, deviceId: string, app: string, frontend: string): Promise<void> {
  await store.putTrusted({ deviceId, app, origin: new URL(frontend).origin });
}
