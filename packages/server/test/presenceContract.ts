/**
 * PresenceStore contract tests, written against the INTERFACE only.
 * Any future store (e.g. Redis) can reuse them: presenceContract('Redis', () => new RedisPresenceStore(...)).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PiConnection, PresenceStore } from '../src/presence/PresenceStore.js';

function fakeConn(): PiConnection {
  return { send: () => undefined, close: () => undefined };
}

export function presenceContract(name: string, factory: () => PresenceStore | Promise<PresenceStore>): void {
  test(`[${name}] starts empty`, async () => {
    const s = await factory();
    assert.equal(await s.count(), 0);
    assert.equal(await s.isOnline('x'), false);
    assert.equal(await s.getConnection('x'), undefined);
  });

  test(`[${name}] setOnline / getConnection / count`, async () => {
    const s = await factory();
    const a = fakeConn();
    await s.setOnline('pi-a', a);
    await s.setOnline('pi-b', fakeConn());
    assert.equal(await s.isOnline('pi-a'), true);
    assert.equal(await s.getConnection('pi-a'), a);
    assert.equal(await s.count(), 2);
  });

  test(`[${name}] setOffline removes the registered connection`, async () => {
    const s = await factory();
    const a = fakeConn();
    await s.setOnline('pi-a', a);
    await s.setOffline('pi-a', a);
    assert.equal(await s.isOnline('pi-a'), false);
    assert.equal(await s.count(), 0);
  });

  test(`[${name}] setOffline with an OLD connection does not remove a newer one`, async () => {
    const s = await factory();
    const old = fakeConn();
    const fresh = fakeConn();
    await s.setOnline('pi-a', old);
    await s.setOnline('pi-a', fresh); // reconnect replaced it
    await s.setOffline('pi-a', old); // the old socket's close event arrives late
    assert.equal(await s.isOnline('pi-a'), true);
    assert.equal(await s.getConnection('pi-a'), fresh);
    assert.equal(await s.count(), 1);
  });

  test(`[${name}] setOffline for an unknown device is a no-op`, async () => {
    const s = await factory();
    await s.setOffline('nobody', fakeConn());
    assert.equal(await s.count(), 0);
  });
}
