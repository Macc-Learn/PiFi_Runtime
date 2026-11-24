/**
 * Shared crypto helpers (Phase 1 revision + Phase 2).
 *
 * ALL algorithm-specific code lives in this one file, so switching from
 * ECDSA P-256 to Ed25519 later touches one place. The runtime (Pi identity)
 * and the signaling server (verifying a Pi's registration) both import it,
 * so they can never disagree about how a deviceId is computed.
 *
 * Why ECDSA P-256: every browser's WebCrypto supports it, and the phone must be
 * able to verify the Pi's signatures in later phases.
 * Why IEEE P1363 signatures: WebCrypto produces/expects raw r||s (64 bytes), not DER.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

import { base32Encode } from './encoding.js';
import { pairProofMessage } from './signed.js';

export const KEY_ALGORITHM = 'ECDSA-P256' as const;
export const P1363_SIGNATURE_BYTES = 64;

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

export { base32Encode } from './encoding.js';

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict base64url decode: returns undefined for anything that isn't clean base64url. */
export function fromBase64url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const buf = Buffer.from(text, 'base64url');
  // Round-trip check rejects sloppy input (e.g. impossible trailing bits).
  return buf.toString('base64url') === text ? buf : undefined;
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/**
 * deviceId = lowercase base32 (no padding) of SHA-256(SPKI DER public key).
 * Always 52 characters. A browser reproduces it with
 * `crypto.subtle.exportKey('spki', key)` -> SHA-256 -> base32.
 */
export function deviceIdFromSpki(spkiDer: Uint8Array): string {
  return base32Encode(createHash('sha256').update(spkiDer).digest());
}

export const DEVICE_ID_REGEX = /^[a-z2-7]{52}$/;

/** Parse SPKI DER and confirm it is a P-256 key. Returns undefined for anything else. */
export function importP256Spki(spkiDer: Uint8Array): KeyObject | undefined {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/** Verify an ECDSA P-256 / SHA-256 signature in IEEE P1363 (raw r||s) form. Never throws. */
export function verifyP1363(spkiDer: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== P1363_SIGNATURE_BYTES) return false;
  const key = importP256Spki(spkiDer);
  if (!key) return false;
  try {
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** Sign with a P-256 private key, producing a 64-byte P1363 signature. */
export function signP1363(privateKey: KeyObject, message: Uint8Array): Buffer {
  return sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

export function generateP256KeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

export function spkiDerFromPem(pem: string): Buffer {
  return createPublicKey({ key: pem, format: 'pem' }).export({ format: 'der', type: 'spki' });
}

/** 32 random bytes, base64url (43 chars). Used for challenge nonces. */
export function randomNonce(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The pairing proof a phone sends (Phase 3 §4.2):
 *   HMAC-SHA256(key = secret bytes, "pifi-pair-v1" || deviceId || phoneSpki)
 * `secret` is the base64url string from the QR; the key is its 16 decoded bytes.
 */
export function pairProof(secret: string, deviceId: string, phoneSpki: Uint8Array): Buffer {
  const key = fromBase64url(secret);
  if (!key) throw new Error('pairing secret is not base64url');
  return createHmac('sha256', key).update(pairProofMessage(deviceId, phoneSpki)).digest();
}

/** phoneId uses the same derivation as a Pi's deviceId. */
export const phoneIdFromSpki = deviceIdFromSpki;
