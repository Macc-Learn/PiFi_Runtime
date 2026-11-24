/** Phase 3 protocol pieces, checked against vectors computed independently (Python/OpenSSL). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { pairProof, phoneIdFromSpki, verifyP1363 } from '../src/crypto.js';
import * as B from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(path.resolve(here, '../../test/vectors.json'), 'utf8'));
const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

test('signedMessage: context then length-prefixed parts', () => {
  const v = V.signedMessage;
  assert.equal(toHex(B.signedMessage(v.context, ...v.parts_hex.map(hex))), v.expected_hex);
  const s = V.sessionPhone;
  const msg = B.signedMessage(B.SESSION_PHONE_CONTEXT, B.utf8(s.deviceId), B.utf8(s.phoneId), B.b64urlDecode(s.np)!, B.b64urlDecode(s.nc)!, hex(s.fingerprint_hex));
  assert.equal(toHex(msg), s.expected_hex);
  // Moving a byte between parts changes the message (that's what the length prefixes are for).
  assert.notEqual(toHex(B.signedMessage('c', B.utf8('ab'), B.utf8('c'))), toHex(B.signedMessage('c', B.utf8('a'), B.utf8('bc'))));
});

test('fingerprintBytes: accepts one consistent sha-256, rejects everything else', () => {
  const f = V.fingerprints;
  assert.equal(toHex(B.fingerprintBytes(f.good)!), f.good_hex, 'case-insensitive, repeated lines allowed when equal');
  for (const bad of ['none', 'mixed', 'differing', 'malformed', 'short']) assert.equal(B.fingerprintBytes(f[bad]), undefined, bad);
});

test('pairing HMAC proof and phoneId derivation', async () => {
  const p = V.pairProof;
  const spki = B.b64urlDecode(p.phoneSpki)!;
  assert.equal(B.b64urlEncode(pairProof(p.secret, p.deviceId, spki)), p.expectedProof, 'Node');
  const key = await webcrypto.subtle.importKey('raw', B.b64urlDecode(p.secret)!, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await webcrypto.subtle.sign('HMAC', key, B.pairProofMessage(p.deviceId, spki)));
  assert.equal(B.b64urlEncode(mac), p.expectedProof, 'WebCrypto');
  assert.equal(phoneIdFromSpki(spki), V.phoneId.expected);
  assert.equal(B.base32Encode(new Uint8Array(await webcrypto.subtle.digest('SHA-256', spki))), V.phoneId.expected, 'browser derivation');
});

test('P1363 signature from OpenSSL verifies in Node and in WebCrypto', async () => {
  const v = V.p1363;
  const spki = B.b64urlDecode(v.spki)!;
  const sig = B.b64urlDecode(v.signature)!;
  assert.equal(verifyP1363(spki, B.utf8(v.message_utf8), sig), true);
  const key = await webcrypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, B.utf8(v.message_utf8)), true);
});

test('browser base64url matches Node and is strict', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = webcrypto.getRandomValues(new Uint8Array(n));
    const enc = B.b64urlEncode(bytes);
    assert.equal(enc, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(B.b64urlDecode(enc), bytes);
  }
  for (const bad of ['a', 'ab=', 'a+b/', 'AB', '!!!!']) {
    if (bad === 'AB') assert.equal(B.b64urlDecode(bad), undefined, 'non-canonical trailing bits');
    else assert.equal(B.b64urlDecode(bad), undefined, bad);
  }
});

test('relay bodies round-trip and reject anything off-schema', () => {
  const body = { k: 'session.hello', phoneId: 'a'.repeat(52), np: B.b64urlEncode(new Uint8Array(16)) } as const;
  const enc = B.encodeRelayBody(body);
  assert.deepEqual(B.decodeRelayBody(B.PhoneToPiBodySchema, enc), body);
  assert.equal(B.decodeRelayBody(B.PiToPhoneBodySchema, enc), undefined, 'direction matters');
  for (const junk of ['!!', B.b64urlEncode(B.utf8('not json')), B.encodeRelayBody({ ...body, extra: 1 } as never), B.b64urlEncode(new Uint8Array([0xff, 0xfe]))]) {
    assert.equal(B.decodeRelayBody(B.PhoneToPiBodySchema, junk), undefined);
  }
  const huge = B.b64urlEncode(B.utf8(JSON.stringify({ k: 'session.offer', sdp: 'x'.repeat(20_000), sig: 'A'.repeat(86) })));
  assert.equal(B.decodeRelayBody(B.PhoneToPiBodySchema, huge), undefined, 'over 12 KiB');
});

test('wire frames: valid frames parse, malformed/oversized/unknown do not; chunks round-trip', () => {
  assert.deepEqual(B.parseWireFrame('{"t":"req","id":"1","app":"echo","op":"echo","payload":{"a":1}}'), { t: 'req', id: '1', app: 'echo', op: 'echo', payload: { a: 1 } });
  assert.ok(B.parseWireFrame('{"t":"ping","n":3}'));
  assert.ok(B.parseWireFrame('{"t":"s.open","sid":1,"app":"echo","op":"upload-echo"}'));
  for (const bad of ['nope', '{"t":"zzz"}', '{"t":"req","id":"' + 'x'.repeat(33) + '","op":"a"}', '{"t":"req","id":"1","app":"../x","op":"a"}',
    '{"t":"ping","n":1,"extra":true}', '{"t":"s.open","sid":0,"app":"a","op":"b"}', JSON.stringify({ t: 'req', id: '1', op: 'a', payload: 'x'.repeat(70_000) })]) {
    assert.equal(B.parseWireFrame(bad), undefined, bad.slice(0, 60));
  }
  const chunk = B.encodeChunk(0xdeadbeef, new Uint8Array([1, 2, 3]));
  assert.deepEqual(B.decodeChunk(chunk), { sid: 0xdeadbeef, data: new Uint8Array([1, 2, 3]) });
  assert.equal(B.decodeChunk(new Uint8Array(3)), undefined);
  assert.equal(B.decodeChunk(B.encodeChunk(1, new Uint8Array(16 * 1024 + 1))), undefined, 'over 16 KiB');
  assert.equal(B.decodeChunk(B.encodeChunk(0, new Uint8Array(1))), undefined, 'sid 0 is invalid');
});

test('the browser entry imports nothing from node:*', () => {
  const dist = path.resolve(here, '../src');
  for (const f of ['browser.js', 'encoding.js', 'signed.js', 'relay.js', 'wire.js', 'names.js', 'signaling.js', 'port.js']) {
    assert.doesNotMatch(readFileSync(path.join(dist, f), 'utf8'), /from ['"]node:|require\(|Buffer\./, f);
  }
});
