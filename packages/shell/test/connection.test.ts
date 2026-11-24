/** Connection manager: backoff, fatal errors, reconnect triggers, DISCONNECTED while down. */
import { describe, expect, it } from 'vitest';
import { ConnectionManager, type ConnStatus } from '../src/core/connection.js';
import { ShellError } from '../src/core/errors.js';
import type { OpenSession } from '../src/core/session.js';
import type { PiRecord } from '../src/core/store.js';
import { FakeDataChannel, tick } from './fakes.js';

const pi = { deviceId: 'a'.repeat(52), phoneId: 'b'.repeat(52) } as PiRecord;

function harness(results: Array<'ok' | ShellError>, clock = { t: 0 }) {
  const channels: FakeDataChannel[] = [];
  const statuses: ConnStatus[] = [];
  let calls = 0;
  const cm = new ConnectionManager({
    pi, signalUrl: 'ws://x', iceServers: [],
    env: { crypto, WebSocket: undefined as never, RTCPeerConnection: undefined as never, now: () => clock.t, random: () => 0.5 },
    minBackoffMs: 10, maxBackoffMs: 80, stableMs: 1000, pingMs: 60_000,
    openSession: async (): Promise<OpenSession> => {
      const r = results[Math.min(calls++, results.length - 1)];
      if (r !== 'ok') throw r;
      const ch = new FakeDataChannel();
      ch.readyState = 'open';
      // Answer pings like a Pi would.
      ch.onSend = (d) => { if (typeof d === 'string' && d.includes('"ping"')) ch.receive(d.replace('ping', 'pong')); };
      channels.push(ch);
      return { pc: { close() {} } as RTCPeerConnection, channel: ch as unknown as RTCDataChannel };
    },
  });
  cm.onStatus((s) => statuses.push(s));
  return { cm, channels, statuses, calls: () => calls };
}

describe('ConnectionManager', () => {
  it('retries with exponential backoff, then goes online', async () => {
    const h = harness([new ShellError('PI_OFFLINE'), new ShellError('UNREACHABLE'), 'ok']);
    h.cm.start();
    await tick(100);
    expect(h.cm.state.state).toBe('online');
    expect(h.statuses.filter((s) => s.retryInMs !== undefined).map((s) => [s.reason, s.retryInMs])).toEqual([['PI_OFFLINE', 10], ['UNREACHABLE', 20]]);
    h.cm.stop();
  });

  it('caps the backoff at the maximum', async () => {
    const h = harness([new ShellError('SERVER_UNREACHABLE')]);
    h.cm.start();
    await tick(400);
    const delays = h.statuses.filter((s) => s.retryInMs !== undefined).map((s) => s.retryInMs);
    expect(delays.slice(0, 5)).toEqual([10, 20, 40, 80, 80]);
    h.cm.stop();
  });

  it('NOT_PAIRED and KEY_MISSING are fatal: offline, no retries', async () => {
    for (const code of ['NOT_PAIRED', 'KEY_MISSING'] as const) {
      const h = harness([new ShellError(code)]);
      h.cm.start();
      await tick(60);
      expect(h.cm.state).toEqual({ state: 'offline', reason: code });
      expect(h.calls()).toBe(1);
      h.cm.reconnectNow();
      await tick(20);
      expect(h.calls()).toBe(1);
    }
  });

  it('requests fail with DISCONNECTED while not online, and work once online', async () => {
    const h = harness([new ShellError('PI_OFFLINE'), 'ok']);
    h.cm.start();
    await expect(h.cm.request('status')).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await tick(50);
    const pending = h.cm.request('status');
    const sent = JSON.parse(h.channels[0]!.sent.at(-1) as string);
    h.channels[0]!.receive(JSON.stringify({ t: 'res', id: sent.id, ok: true, payload: { up: 1 } }));
    expect(await pending).toEqual({ up: 1 });
    h.cm.stop();
  });

  it('a drop after a stable connection reconnects at once and resets the backoff; a flapping one backs off', async () => {
    const clock = { t: 0 };
    const h = harness(['ok'], clock);
    h.cm.start();
    await tick(10);
    clock.t += 5000; // stayed up longer than stableMs
    const mark = h.statuses.length;
    h.channels[0]!.close();
    await tick(5);
    expect(h.statuses.slice(mark).find((s) => s.retryInMs !== undefined)).toMatchObject({ state: 'reconnecting', retryInMs: 0 });
    await tick(20);
    expect(h.cm.state.state).toBe('online');
    const mark2 = h.statuses.length;
    h.channels[1]!.close(); // drops immediately: no longer "stable"
    await tick(1);
    expect(h.statuses.slice(mark2).find((s) => s.retryInMs !== undefined)?.retryInMs).toBe(10);
    h.cm.stop();
  });

  it('reconnectNow skips the wait (tab visible / network back)', async () => {
    const h = harness([new ShellError('PI_OFFLINE'), 'ok']);
    const slow = new ConnectionManager({ ...(h.cm as unknown as { o: ConstructorParameters<typeof ConnectionManager>[0] }).o, minBackoffMs: 10_000 });
    slow.start();
    await tick(10);
    expect(slow.state.state).toBe('reconnecting');
    slow.reconnectNow();
    await tick(10);
    expect(slow.state.state).toBe('online');
    slow.stop();
  });

  it('two missed pongs count as a dead connection', async () => {
    const ch = new FakeDataChannel();
    ch.readyState = 'open';
    const cm = new ConnectionManager({
      pi, signalUrl: 'ws://x', iceServers: [], pingMs: 10, minBackoffMs: 10_000,
      env: { crypto, WebSocket: undefined as never, RTCPeerConnection: undefined as never, now: () => 0, random: () => 0.5 },
      openSession: async () => ({ pc: { close() {} } as RTCPeerConnection, channel: ch as unknown as RTCDataChannel }), // never answers pings
    });
    cm.start();
    await tick(80);
    expect(cm.state.state).toBe('reconnecting');
    expect(ch.readyState).toBe('closed');
    cm.stop();
  });
});
