import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  base32Encode, deviceIdFromSpki, fromBase64url, generateP256KeyPair, privateKeyFromPem,
  randomNonce, signP1363, spkiDerFromPem, toBase64url, verifyP1363, DEVICE_ID_REGEX,
} from '../src/crypto.js';

/**
 * Fixed test vector. The expected deviceId was computed independently with
 * Python (hashlib.sha256 + base64.b32encode, lowercased, padding stripped),
 * not with this code, so this test catches mistakes in our base32.
 */
export const VECTOR_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFJj1Uws1bgRv18E5cdNHf7KicdBY
V1G+7Fp7HYrFvatyUAOZgdb3gPB60f5jHBFjRTZ/+v5oPXaOa3KpD5E/oQ==
-----END PUBLIC KEY-----
`;
export const VECTOR_DEVICE_ID = 'z5dl7h456ex5woaiskix3ibleex7mhkeu54jkpxduk3pkpsx2w7q';

test('deviceId matches the fixed test vector', () => {
  const der = spkiDerFromPem(VECTOR_PUBLIC_PEM);
  assert.equal(der.length, 91);
  assert.equal(deviceIdFromSpki(der), VECTOR_DEVICE_ID);
  assert.match(VECTOR_DEVICE_ID, DEVICE_ID_REGEX);
});

test('base32 matches RFC 4648 test vectors (lowercase, unpadded)', () => {
  const cases: Array<[string, string]> = [
    ['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi'],
  ];
  for (const [input, expected] of cases) assert.equal(base32Encode(Buffer.from(input)), expected, input);
  assert.equal(base32Encode(createHash('sha256').digest()).length, 52);
});

test('P1363 signatures verify, and the same signature verifies in WebCrypto', async () => {
  const { privateKeyPem, publicKeyPem } = generateP256KeyPair();
  const der = spkiDerFromPem(publicKeyPem);
  const msg = Buffer.from('hello pifi');
  const sig = signP1363(privateKeyFromPem(privateKeyPem), msg);
  assert.equal(sig.length, 64);
  assert.equal(verifyP1363(der, msg, sig), true);
  assert.equal(verifyP1363(der, Buffer.from('tampered'), sig), false);

  const key = await webcrypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, msg), true);
});

test('verifyP1363 rejects garbage keys and signatures without throwing', () => {
  const { publicKeyPem } = generateP256KeyPair();
  const der = spkiDerFromPem(publicKeyPem);
  assert.equal(verifyP1363(Buffer.from('nope'), Buffer.from('m'), Buffer.alloc(64)), false);
  assert.equal(verifyP1363(der, Buffer.from('m'), Buffer.alloc(10)), false);
  assert.equal(verifyP1363(der, Buffer.from('m'), Buffer.alloc(64)), false);
});

test('base64url helpers are strict; nonces are 32 random bytes', () => {
  assert.deepEqual(fromBase64url(toBase64url(Buffer.from([1, 2, 255]))), Buffer.from([1, 2, 255]));
  assert.equal(fromBase64url('has+plus'), undefined);
  assert.equal(fromBase64url('has=pad'), undefined);
  const n = randomNonce();
  assert.equal(fromBase64url(n)?.length, 32);
  assert.notEqual(randomNonce(), n);
});
