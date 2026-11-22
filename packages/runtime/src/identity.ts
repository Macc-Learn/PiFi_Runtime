/**
 * The Pi's own identity keypair (Phase 1 revision §3.1-3.3).
 *
 *   ${PIFI_HOME}/keys/            mode 0700
 *     identity.key                PKCS#8 PEM private key, mode 0600
 *     identity.pub                SPKI PEM public key
 *
 * deviceId = base32(sha256(SPKI DER)), see @pifi/protocol crypto.ts.
 *
 * The private key lives only inside a closure here. The Identity object has
 * no property that holds it, so it can't leak through JSON.stringify, logs,
 * util.inspect or an API response by accident.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  deviceIdFromSpki, generateP256KeyPair, KEY_ALGORITHM, privateKeyFromPem, signP1363, spkiDerFromPem,
} from '@pifi/protocol';
import { createPublicKey } from 'node:crypto';
import type { Logger } from './logger.js';

export interface Identity {
  readonly deviceId: string;
  readonly publicKeyPem: string;
  /** SPKI DER bytes of the public key (what the signaling server hashes into the deviceId). */
  readonly publicKeyDer: Buffer;
  readonly algorithm: typeof KEY_ALGORITHM;
  /** ECDSA P-256 / SHA-256 signature in IEEE P1363 form (64 bytes, WebCrypto-compatible). */
  sign(data: Uint8Array): Buffer;
}

/** Kept for symmetry with Phase 2's spec wording (`deviceIdFromSpki` lives in @pifi/protocol). */
export const deviceIdFromPublicKey = deviceIdFromSpki;

export function keysDir(home: string): string {
  return path.join(home, 'keys');
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Write via an exclusive-create temp file, then rename: a crash never leaves a half-written key. */
async function writeSecretFile(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { flag: 'wx', mode });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

let warnedWindows = false;

function buildIdentity(privatePem: string, publicPem: string): Identity {
  const privateKey = privateKeyFromPem(privatePem); // captured by the closure below only
  const publicKeyDer = spkiDerFromPem(publicPem);

  // Refuse a mismatched pair: the .pub must really belong to the .key.
  const derivedDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (!derivedDer.equals(publicKeyDer)) {
    throw new Error('identity.pub does not match identity.key; refusing to start (restore the original pair from backup)');
  }

  const identity: Identity = {
    deviceId: deviceIdFromSpki(publicKeyDer),
    publicKeyPem: publicPem,
    publicKeyDer,
    algorithm: KEY_ALGORITHM,
    sign: (data) => signP1363(privateKey, data),
  };
  return Object.freeze(identity);
}

export async function loadOrCreateIdentity(home: string, log: Logger): Promise<Identity> {
  const dir = keysDir(home);
  const keyFile = path.join(dir, 'identity.key');
  const pubFile = path.join(dir, 'identity.pub');

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined); // mkdir's mode is ignored if the folder already existed
  if (process.platform === 'win32' && !warnedWindows) {
    warnedWindows = true;
    log.warn('Windows: file permissions on keys/ cannot be enforced; keep PIFI_HOME private to your user');
  }

  const hasKey = await exists(keyFile);
  const hasPub = await exists(pubFile);

  if (hasKey !== hasPub) {
    // Never silently regenerate: that would give the Pi a new identity and break every pairing.
    const present = hasKey ? 'identity.key' : 'identity.pub';
    const missing = hasKey ? 'identity.pub' : 'identity.key';
    throw new Error(
      `identity is incomplete: ${present} exists in ${dir} but ${missing} is missing. ` +
        `Refusing to start so the device identity is not replaced. Restore ${missing} from backup, ` +
        `or delete BOTH files to create a new identity (this unpairs every phone).`,
    );
  }

  if (!hasKey) {
    const pair = generateP256KeyPair();
    await writeSecretFile(keyFile, pair.privateKeyPem, 0o600);
    await writeSecretFile(pubFile, pair.publicKeyPem, 0o644);
    const identity = buildIdentity(pair.privateKeyPem, pair.publicKeyPem);
    log.info(`created device identity ${identity.deviceId.slice(0, 8)}…`);
    return identity;
  }

  await chmod(keyFile, 0o600).catch(() => undefined);
  const identity = buildIdentity(await readFile(keyFile, 'utf8'), await readFile(pubFile, 'utf8'));
  log.info(`loaded device identity ${identity.deviceId.slice(0, 8)}…`);
  return identity;
}
