/**
 * The phone's crypto, all WebCrypto. Private keys are created NON-EXTRACTABLE:
 * the browser can use them to sign but nothing (not even this code) can read
 * them out. Signatures from WebCrypto ECDSA are already IEEE P1363 (r||s).
 */
import { b64urlDecode, base32Encode, pairProofMessage } from '@pifi/protocol/browser';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

// WebCrypto wants BufferSource; copying into a fresh ArrayBuffer keeps every TS lib happy.
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export function randomBytes(crypto: Crypto, n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function generatePhoneKeyPair(crypto: Crypto): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function exportSpki(crypto: Crypto, publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
}

export async function sign(crypto: Crypto, privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, buf(data)));
}

/** Never throws: a malformed key or signature simply doesn't verify. */
export async function verifyP1363(crypto: Crypto, spki: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', buf(spki), ECDSA, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, buf(signature), buf(data));
  } catch {
    return false;
  }
}

/** base32(sha256(SPKI)): the same derivation the Pi uses for deviceId / phoneId. */
export async function idFromSpki(crypto: Crypto, spki: Uint8Array): Promise<string> {
  return base32Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(spki))));
}

/** HMAC-SHA256(key = secret bytes, "pifi-pair-v1" || deviceId || phoneSpki). The secret itself never leaves the phone. */
export async function pairProof(crypto: Crypto, secretB64: string, deviceId: string, phoneSpki: Uint8Array): Promise<Uint8Array> {
  const secret = b64urlDecode(secretB64);
  if (!secret) throw new Error('pairing secret is not base64url');
  const key = await crypto.subtle.importKey('raw', buf(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, buf(pairProofMessage(deviceId, phoneSpki))));
}
