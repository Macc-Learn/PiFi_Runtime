/** Phase 3 §8: app ops, events, streams and capabilities, against the real echo app. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CloseCode, PROTOCOL_VERSION, encodeChunk, type StreamMessage } from '@pifi/protocol';
import { AppStreams, type StreamEndpoint } from '../src/appStreams.js';
import { PifiError } from '../src/errors.js';
import { loadRegistry, registeredAppsDir } from '../src/registry.js';
import { silentLogger } from '../src/logger.js';
import { makeHome, sleep, startDaemon, waitFor } from './helpers.js';

function collector(): StreamEndpoint & { chunks: Uint8Array[]; ended: boolean; aborted?: string } {
  const c = {
    chunks: [] as Uint8Array[],
    ended: false,
    aborted: undefined as string | undefined,
    onData: (d: Uint8Array) => { c.chunks.push(new Uint8Array(d)); },
    onEnd: () => { c.ended = true; },
    onAbort: (r: string) => { c.aborted = r; },
  };
  return c;
}

test('echo ops: echo returns the payload; unknown op keeps the app error code', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    await t.daemon.manager.start('echo');
    assert.deepEqual(await t.daemon.manager.request('echo', { op: 'echo', payload: { a: [1, 2] } }), { a: [1, 2] });
    await assert.rejects(t.daemon.manager.request('echo', { op: 'nope' }), (e: unknown) => e instanceof PifiError && e.code === 'APP_ERROR' && e.appCode === 'NOT_FOUND');
  } finally {
    await t.cleanup();
  }
});

test('events from the app are emitted by the manager', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    await t.daemon.manager.start('echo');
    const seen: unknown[] = [];
    t.daemon.manager.on('appEvent', (app: string, name: string, data: unknown) => { if (app === 'echo' && name === 'count') seen.push(data); });
    await t.daemon.manager.request('echo', { op: 'count', payload: { intervalMs: 50 } });
    await waitFor(() => seen.length >= 3, 3000, 'three count events');
    await t.daemon.manager.request('echo', { op: 'stop' });
    const n = seen.length;
    await sleep(200);
    assert.ok(seen.length <= n + 1, 'stop stops the events');
    assert.deepEqual(seen[0], { n: 1 });
  } finally {
    await t.cleanup();
  }
});

test('stream: upload-echo returns every byte, half-close works both ways', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    await t.daemon.manager.start('echo');
    const out = collector();
    const s = await t.daemon.manager.openStream('echo', 'upload-echo', { name: 'x' }, out);
    const sent = new Uint8Array(100_000).map((_, i) => i % 251);
    for (let o = 0; o < sent.length; o += 16_384) assert.equal(s.write(sent.subarray(o, o + 16_384)), true);
    s.end(); // done SENDING; the app still sends the echo back
    await waitFor(() => out.ended, 5000, 'app to end its side');
    const got = Buffer.concat(out.chunks);
    assert.equal(got.length, sent.length);
    assert.ok(got.equals(Buffer.from(sent)));
    assert.equal(t.daemon.manager.records.get('echo')!.streams!.size, 0, 'closed once both sides ended');
  } finally {
    await t.cleanup();
  }
});

test('stream: unknown op is rejected by the app; apps without "streams" cannot stream', async () => {
  const t = await startDaemon({ apps: ['echo', 'mute'] });
  try {
    await Promise.all([t.daemon.manager.start('echo'), t.daemon.manager.start('mute')]);
    await assert.rejects(t.daemon.manager.openStream('echo', 'nope', {}, collector()), /NO_HANDLER/);
    assert.throws(() => t.daemon.manager.openStream('mute', 'x', {}, collector()), (e: unknown) => e instanceof PifiError && e.code === 'BAD_REQUEST');
  } finally {
    await t.cleanup();
  }
});

test('binary frames and stream messages are refused from apps that did not declare "streams"', async () => {
  const t = await startDaemon({ apps: ['echo'] });
  try {
    const closes: Array<[number, string]> = [];
    const fakeWs = { readyState: 1, bufferedAmount: 0, send() {}, close: (c: number, r: string) => closes.push([c, r]), terminate() {} };
    // Pretend a hello arrived without capabilities.
    t.daemon.manager.attachSocket('echo', fakeWs as never, []);
    t.daemon.manager.onAppBinary('echo', fakeWs as never, encodeChunk(1, new Uint8Array([1])));
    t.daemon.manager.onAppMessage('echo', fakeWs as never, { v: PROTOCOL_VERSION, type: 'stream.end', sid: 1 });
    assert.deepEqual(closes.map((c) => c[0]), [CloseCode.PROTOCOL_VIOLATION, CloseCode.PROTOCOL_VIOLATION]);
  } finally {
    t.daemon.manager.records.get('echo')!.ws = undefined;
    await t.cleanup();
  }
});

// ---- AppStreams unit tests with a fake socket ----

function fakeIo() {
  const sent: StreamMessage[] = [];
  const binary: Uint8Array[] = [];
  let buffered = 0;
  return { sent, binary, setBuffered: (n: number) => { buffered = n; }, io: { send: (m: StreamMessage) => sent.push(m), sendBinary: (b: Uint8Array) => binary.push(b), bufferedAmount: () => buffered } };
}

test('AppStreams: per-app cap, odd sids, open timeout, idle timeout, slow-app abort', async () => {
  const f = fakeIo();
  const streams = new AppStreams('demo', f.io, { maxStreams: 2, idleMs: 80, openTimeoutMs: 60, maxAppBacklog: 1000 }, silentLogger);

  const a = streams.open('op', {}, collector());
  const b = streams.open('op', {}, collector());
  await assert.rejects(streams.open('op', {}, collector()), /2 open streams/);
  const sids = f.sent.filter((m) => m.type === 'stream.open').map((m) => m.sid);
  assert.deepEqual(sids, [1, 3], 'PiFi-opened streams are odd');

  streams.onMessage({ v: 1, type: 'stream.accept', sid: 1 });
  const ha = await a;
  await assert.rejects(b, /did not accept/, 'open timeout');

  const sink = collector();
  const hc = await (async () => { const p = streams.open('op', {}, sink); streams.onMessage({ v: 1, type: 'stream.accept', sid: 5 }); return p; })();
  f.setBuffered(5000); // app has stopped reading
  assert.equal(hc.write(new Uint8Array(10)), false);
  assert.equal(sink.aborted, 'app not reading');
  f.setBuffered(0);

  await sleep(150);
  assert.equal(streams.size, 0, 'idle stream aborted');
  assert.ok(f.sent.some((m) => m.type === 'stream.abort' && m.sid === ha.sid && m.reason === 'idle timeout'));
});

test('AppStreams: app-opened streams need an even sid and a session', () => {
  const f = fakeIo();
  const opened: string[] = [];
  const streams = new AppStreams('demo', f.io, { maxStreams: 4, idleMs: 1000, openTimeoutMs: 1000, maxAppBacklog: 1e6 }, silentLogger, (req) => {
    opened.push(req.session);
    req.accept(collector());
  });
  streams.onMessage({ v: 1, type: 'stream.open', sid: 3, op: 'x' });
  streams.onMessage({ v: 1, type: 'stream.open', sid: 4, op: 'x' });
  streams.onMessage({ v: 1, type: 'stream.open', sid: 6, op: 'x', session: 's1' });
  assert.deepEqual(f.sent.map((m) => m.type), ['stream.reject', 'stream.reject', 'stream.accept']);
  assert.deepEqual(opened, ['s1']);
  streams.closeAll('bye');
  assert.equal(streams.size, 0);
});

test('manifest: frontend must be https (localhost only in dev); displayName max 40', async () => {
  const home = await makeHome();
  const write = async (name: string, extra: Record<string, unknown>): Promise<void> => {
    const dir = path.join(registeredAppsDir(home), name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'pifi.json'), JSON.stringify({ name, version: '1.0.0', command: 'node', memoryMB: 10, ...extra }));
  };
  await write('secure', { frontend: 'https://example.com/app', displayName: 'Secure' });
  await write('plain', { frontend: 'http://example.com/app' });
  await write('local', { frontend: 'http://localhost:5173/' });
  await write('script', { frontend: 'javascript:alert(1)' });
  await write('longname', { displayName: 'x'.repeat(41) });

  const prod = await loadRegistry(home, { dev: false });
  assert.deepEqual(prod.entries.map((e) => e.manifest.name), ['secure']);
  const dev = await loadRegistry(home, { dev: true });
  assert.deepEqual(dev.entries.map((e) => e.manifest.name).sort(), ['local', 'secure']);
});
