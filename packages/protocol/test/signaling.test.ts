import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FirstMessageSchema, PhoneMessageSchema, PiFollowupSchema, parseSignal, registrationMessage } from '../src/signaling.js';

const id = 'a'.repeat(52);

test('first message decides the role; unknown/invalid messages are rejected', () => {
  assert.equal(parseSignal(FirstMessageSchema, JSON.stringify({ v: 1, type: 'pi.hello', deviceId: id, publicKey: 'AAAA' }))?.type, 'pi.hello');
  assert.equal(parseSignal(FirstMessageSchema, JSON.stringify({ v: 1, type: 'query', deviceId: id }))?.type, 'query');
  assert.equal(parseSignal(FirstMessageSchema, JSON.stringify({ v: 1, type: 'relay', deviceId: id, payload: 'eA' }))?.type, 'relay');
  for (const bad of ['not json', '{}', JSON.stringify({ v: 2, type: 'query', deviceId: id }), JSON.stringify({ v: 1, type: 'query', deviceId: 'SHORT' }),
    JSON.stringify({ v: 1, type: 'query', deviceId: id, extra: 1 }), JSON.stringify({ v: 1, type: 'relay', deviceId: id, payload: 'not base64!' })]) {
    assert.equal(parseSignal(FirstMessageSchema, bad), undefined, bad);
  }
});

test('role-specific schemas keep Pi and phone messages apart', () => {
  const piRelay = JSON.stringify({ v: 1, type: 'relay', peerId: 'f'.repeat(32), payload: 'eA' });
  const phoneRelay = JSON.stringify({ v: 1, type: 'relay', deviceId: id, payload: 'eA' });
  assert.ok(parseSignal(PiFollowupSchema, piRelay));
  assert.equal(parseSignal(PiFollowupSchema, phoneRelay), undefined);
  assert.ok(parseSignal(PhoneMessageSchema, phoneRelay));
  assert.equal(parseSignal(PhoneMessageSchema, piRelay), undefined);
  assert.equal(parseSignal(PhoneMessageSchema, JSON.stringify({ v: 1, type: 'pi.auth', signature: 'A'.repeat(86) })), undefined);
});

test('registration message is the fixed-length concatenation', () => {
  const nonce = 'N'.repeat(43);
  assert.equal(registrationMessage(nonce, id).toString('utf8'), `pifi-register-v1${nonce}${id}`);
  assert.equal(registrationMessage(nonce, id).length, 16 + 43 + 52);
});
