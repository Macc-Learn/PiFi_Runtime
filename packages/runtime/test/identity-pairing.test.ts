/** Phase 1 revision tests: device identity, pairing codes, new control API routes and CLI commands. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { webcrypto } from 'node:crypto';
import { deviceIdFromSpki, generateP256KeyPair, spkiDerFromPem } from '@pifi/protocol';
import { PairingManager } from '../src/pairing.js';
import { PifiError } from '../src/errors.js';
import { adminHeaders, call, makeHome, memoryLogger, runCli, startDaemon } from './helpers.js';

/** Every file under a directory, recursively (to prove a secret was never written anywhere). */
async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await allFiles(full)));
    else if (d.isFile()) out.push(full);
  }
  return out;
}

/** The base64 body of a PEM, i.e. the actual key material. */
const pemBody = (pem: string): string => pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('identity is created on first start and reused on the second', async () => {
  const home = await makeHome();
  let t = await startDaemon({ home, keepHome: true });
  const first = t.daemon.identity.deviceId;
  await t.cleanup();
  t = await startDaemon({ home });
  try {
    assert.equal(t.daemon.identity.deviceId, first);
    const pub = await readFile(path.join(home, 'keys', 'identity.pub'), 'utf8');
    assert.equal(deviceIdFromSpki(spkiDerFromPem(pub)), first, 'deviceId = base32(sha256(SPKI DER))');
    assert.equal(first.length, 52);
  } finally {
    await t.cleanup();
  }
});

test('key directory is 0700 and private key 0600', { skip: process.platform === 'win32' }, async () => {
  const t = await startDaemon();
  try {
    assert.equal((await stat(path.join(t.home, 'keys'))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(t.home, 'keys', 'identity.key'))).mode & 0o777, 0o600);
  } finally {
    await t.cleanup();
  }
});

test('only one key file present -> daemon refuses to start and does not overwrite', async () => {
  for (const keep of ['identity.key', 'identity.pub']) {
    const home = await makeHome();
    let t = await startDaemon({ home, keepHome: true });
    await t.cleanup();
    const other = keep === 'identity.key' ? 'identity.pub' : 'identity.key';
    await unlink(path.join(home, 'keys', other));
    const before = await readFile(path.join(home, 'keys', keep), 'utf8');

    await assert.rejects(startDaemon({ home, keepHome: true }), /identity is incomplete/);
    assert.equal(await readFile(path.join(home, 'keys', keep), 'utf8'), before, `${keep} untouched`);
    await assert.rejects(readFile(path.join(home, 'keys', other)), 'missing file was not regenerated');
    await rm(home, { recursive: true, force: true });
  }
});

test('a public key that does not match the private key is refused', async () => {
  const home = await makeHome();
  let t = await startDaemon({ home, keepHome: true });
  await t.cleanup();
  await writeFile(path.join(home, 'keys', 'identity.pub'), generateP256KeyPair().publicKeyPem);
  await assert.rejects(startDaemon({ home }), /does not match/);
  await rm(home, { recursive: true, force: true });
});

test('sign() output verifies with WebCrypto (browser compatibility)', async () => {
  const t = await startDaemon();
  try {
    const { identity } = t.daemon;
    const data = Buffer.from('challenge from a phone');
    const sig = identity.sign(data);
    assert.equal(sig.length, 64, 'IEEE P1363 raw r||s');
    const key = await webcrypto.subtle.importKey('spki', spkiDerFromPem(identity.publicKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data), true);
  } finally {
    await t.cleanup();
  }
});

test('private key material never appears in /identity, /status, logs, or serialised identity', async () => {
  const mem = memoryLogger();
  const t = await startDaemon({ log: mem.log });
  try {
    const privateBody = pemBody(await readFile(path.join(t.home, 'keys', 'identity.key'), 'utf8'));
    const headers = await adminHeaders(t.home);
    const id = await call(t.daemon.controlPort, { path: '/identity', headers });
    assert.equal(id.status, 200);
    const parsed = JSON.parse(id.body);
    assert.deepEqual(Object.keys(parsed).sort(), ['algorithm', 'deviceId', 'publicKeyPem']);
    assert.equal(parsed.algorithm, 'ECDSA-P256');
    const status = await call(t.daemon.controlPort, { path: '/status', headers });

    for (const [where, text] of [
      ['/identity', id.body], ['/status', status.body], ['logs', mem.lines.join('\n')],
      ['JSON', JSON.stringify(t.daemon.identity)], ['inspect', inspect(t.daemon.identity, { depth: 5, showHidden: true })],
    ] as const) {
      assert.ok(!text.includes(privateBody.slice(0, 40)), `${where} must not contain the private key`);
      assert.ok(!text.includes('PRIVATE'), `${where} must not contain PRIVATE`);
    }
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pairing manager (injected clock)
// ---------------------------------------------------------------------------

test('pairing: secret returned once, never in status; new code replaces old; expiry; revoke', () => {
  let now = 1_000_000;
  const pm = new PairingManager({ now: () => now });
  const a = pm.create(60);
  assert.match(a.secret, /^[A-Za-z0-9_-]{22}$/, '16 bytes base64url');
  assert.equal(a.expiresAt, now + 60_000);
  assert.deepEqual(pm.status(), { active: true, expiresAt: a.expiresAt });
  for (const text of [JSON.stringify(pm.status()), JSON.stringify(pm), inspect(pm, { showHidden: true, depth: 5 })]) {
    assert.ok(!text.includes(a.secret), 'secret must not leak via status/JSON/inspect');
  }

  const b = pm.create(120);
  assert.notEqual(b.secret, a.secret);
  assert.equal(pm.status().expiresAt, b.expiresAt, 'second create replaced the first');

  now += 120_000;
  assert.deepEqual(pm.status(), { active: false }, 'expired');

  pm.create(60);
  pm.revoke();
  assert.deepEqual(pm.status(), { active: false }, 'revoked');

  assert.throws(() => pm.create(0), PifiError);
  assert.throws(() => pm.create(3601), PifiError);
  assert.throws(() => pm.create(1.5), PifiError);
});

// ---------------------------------------------------------------------------
// Control API routes
// ---------------------------------------------------------------------------

test('new routes require the admin token and refuse Origin / non-loopback Host', async () => {
  const t = await startDaemon();
  try {
    const port = t.daemon.controlPort;
    const auth = await adminHeaders(t.home);
    for (const [method, route] of [['GET', '/identity'], ['POST', '/pair'], ['GET', '/pair'], ['DELETE', '/pair']]) {
      assert.equal((await call(port, { method, path: route })).status, 401, `${method} ${route} no token`);
      assert.equal((await call(port, { method, path: route, headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
      assert.equal((await call(port, { method, path: route, headers: { ...auth, host: 'evil.example' } })).status, 403);
    }
  } finally {
    await t.cleanup();
  }
});

test('pair routes: shapes, secret only in POST, never written to disk or logs', async () => {
  const mem = memoryLogger();
  const t = await startDaemon({ log: mem.log });
  try {
    const port = t.daemon.controlPort;
    const headers = await adminHeaders(t.home);
    const created = await call(port, { method: 'POST', path: '/pair', headers, body: JSON.stringify({ ttlSec: 120 }) });
    assert.equal(created.status, 200);
    const code = JSON.parse(created.body);
    assert.deepEqual(Object.keys(code).sort(), ['deviceId', 'expiresAt', 'secret', 'ttlSec']);
    assert.equal(code.deviceId, t.daemon.identity.deviceId);
    assert.equal(code.ttlSec, 120);
    assert.ok(!Number.isNaN(Date.parse(code.expiresAt)), 'expiresAt is an ISO date');

    const status = await call(port, { path: '/pair', headers });
    assert.deepEqual(JSON.parse(status.body), { active: true, expiresAt: code.expiresAt });
    assert.ok(!status.body.includes(code.secret));

    assert.equal((await call(port, { method: 'POST', path: '/pair', headers, body: JSON.stringify({ ttlSec: 99999 }) })).status, 400);
    const noBody = await call(port, { method: 'POST', path: '/pair', headers });
    assert.equal(JSON.parse(noBody.body).ttlSec, 600, 'default TTL');

    await t.daemon.state.flush();
    for (const file of await allFiles(t.home)) {
      assert.ok(!(await readFile(file)).toString('latin1').includes(code.secret), `secret found in ${file}`);
    }
    assert.ok(!mem.lines.join('\n').includes(code.secret), 'secret must never be logged');

    assert.deepEqual(JSON.parse((await call(port, { method: 'DELETE', path: '/pair', headers })).body), { active: false });
    assert.deepEqual(JSON.parse((await call(port, { path: '/pair', headers })).body), { active: false });
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const QR_CHARS = /[█▀▄]/;

test('CLI: pair --json, default pair with QR, identity without private key', async () => {
  const t = await startDaemon();
  try {
    const env = { PIFI_HOME: t.home, PIFI_CONTROL_PORT: String(t.daemon.controlPort), PIFI_FRONTEND_URL: 'https://shell.example/' };

    const json = await runCli(['pair', '--json'], env);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.ok(!QR_CHARS.test(json.stdout), 'no QR characters in --json output');
    assert.equal(parsed.link, `https://shell.example/pair#id=${parsed.deviceId}&s=${parsed.secret}`, 'secret in the #fragment');

    const pretty = await runCli(['pair', '--ttl', '60'], env);
    assert.equal(pretty.code, 0, pretty.stderr);
    assert.ok(QR_CHARS.test(pretty.stdout), 'QR block characters printed');
    assert.match(pretty.stdout, /Pair link: https:\/\/shell\.example\/pair#id=[a-z2-7]{52}&s=[A-Za-z0-9_-]{22}/);
    assert.match(pretty.stdout, /Anyone who sees this QR code/);

    assert.match(pretty.stdout, /Open this on https:\/\/shell\.example/, 'the host is printed prominently');
    const fallback = await runCli(['pair', '--no-qr'], { ...env, PIFI_FRONTEND_URL: '' });
    assert.match(fallback.stdout, /^Open this on https:\/\/macc-learn\.github\.io$/m, 'default is the project Pages site');
    assert.match(fallback.stdout, /Pair link: https:\/\/macc-learn\.github\.io\/PiFi_Runtime\/pair#id=/);
    assert.ok(!QR_CHARS.test(fallback.stdout), '--no-qr');

    const cancel = await runCli(['pair', '--cancel'], env);
    assert.equal(cancel.code, 0);
    assert.equal(t.daemon.pairing.status().active, false);

    const identity = await runCli(['identity'], env);
    assert.equal(identity.code, 0, identity.stderr);
    assert.ok(identity.stdout.includes(t.daemon.identity.deviceId));
    assert.ok(!identity.stdout.includes('PRIVATE'));
    const identityJson = await runCli(['identity', '--json'], env);
    assert.equal(JSON.parse(identityJson.stdout).deviceId, t.daemon.identity.deviceId);
  } finally {
    await t.cleanup();
  }
});
