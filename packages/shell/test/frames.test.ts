/** Frame handoff rules (Phase 3 §10.2): source check, once-only, navigation guard, app binding, limits. */
import { describe, expect, it } from 'vitest';
import { FrameBridge } from '../src/core/frames.js';
import { fakeFrame, tick } from './fakes.js';

function fakeClient() {
  const requests: Array<{ op: string; payload: unknown; app?: string }> = [];
  const subs: string[] = [];
  return {
    requests,
    subs,
    client: {
      request: async (op: string, payload: unknown, opts: { app?: string }) => { requests.push({ op, payload, app: opts.app }); return { ok: op }; },
      subscribe: (app: string) => subs.push(`+${app}`),
      unsubscribe: (app: string) => subs.push(`-${app}`),
      onEvent: () => () => undefined,
      openStream: async () => { throw new Error('no streams in this test'); },
    },
  };
}

function setup() {
  const frame = fakeFrame();
  const fc = fakeClient();
  const destroyed: string[] = [];
  const bridge = new FrameBridge({
    app: 'echo',
    frame,
    client: () => fc.client as never,
    onStatus: (cb) => { cb({ state: 'online' }); return () => undefined; },
    onDestroyed: (r) => destroyed.push(r),
  });
  const hello = { t: 'pifi-hello', v: 1 };
  const port = (): MessagePort => frame.posted.at(-1)!.transfer![0] as MessagePort;
  return { frame, fc, bridge, destroyed, hello, port };
}

async function talk(port: MessagePort, msg: unknown): Promise<unknown[]> {
  const got: unknown[] = [];
  port.onmessage = (e) => got.push(e.data);
  port.postMessage(msg);
  await tick(20);
  return got;
}

describe('FrameBridge', () => {
  it('ignores a hello from any window other than its own frame', () => {
    const s = setup();
    s.frame.load();
    s.bridge.onWindowMessage({ source: {}, data: s.hello });
    s.bridge.onWindowMessage({ source: null, data: s.hello });
    expect(s.frame.posted).toHaveLength(0);
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    expect(s.frame.posted).toHaveLength(1);
    expect(s.frame.posted[0]!.msg).toEqual({ t: 'pifi-port', v: 1 });
  });

  it('hands over a port only once, and only after exactly one load', () => {
    const s = setup();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    expect(s.frame.posted).toHaveLength(0); // not loaded yet
    s.frame.load();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    expect(s.frame.posted).toHaveLength(1);
  });

  it('a second load (navigation) destroys the frame and its port', async () => {
    const s = setup();
    s.frame.load();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    const port = s.port();
    s.frame.load();
    expect(s.bridge.isDestroyed).toBe(true);
    expect(s.frame.removed).toBe(true);
    expect(s.destroyed[0]).toMatch(/navigate/);
    const got = (await talk(port, { t: 'req', id: '1', op: 'echo' })) as Array<{ t: string }>;
    expect(got.filter((m) => m.t !== 'status')).toEqual([]); // (the status was queued before the navigation)
    expect(s.fc.requests).toHaveLength(0);
  });

  it('sets `app` itself; a page cannot pick an app or reach control ops', async () => {
    const s = setup();
    s.frame.load();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    const port = s.port();
    await talk(port, { t: 'req', id: '1', op: 'echo', payload: { a: 1 } });
    await talk(port, { t: 'req', id: '2', op: 'apps.stop', payload: { name: 'files' } }); // looks like a control op
    await talk(port, { t: 'req', id: '3', op: 'x', app: 'files' }); // tries to pick another app: invalid message, dropped
    expect(s.fc.requests).toEqual([
      { op: 'echo', payload: { a: 1 }, app: 'echo' },
      { op: 'apps.stop', payload: { name: 'files' }, app: 'echo' }, // goes to the echo APP, never to PiFi's control op
    ]);
  });

  it('enforces size and rate limits per frame', async () => {
    const s = setup();
    s.frame.load();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    const port = s.port();
    const big = await talk(port, { t: 'req', id: 'b', op: 'x', payload: 'y'.repeat(70_000) });
    expect(big).toContainEqual({ t: 'res', id: 'b', ok: false, error: { code: 'TOO_LARGE', message: 'message over 64 KiB' } });

    const replies: Array<{ error?: { code: string } }> = [];
    port.onmessage = (e) => replies.push(e.data);
    for (let i = 0; i < 150; i++) port.postMessage({ t: 'req', id: `r${i}`, op: 'x' });
    await tick(50);
    expect(replies.filter((r) => r.error?.code === 'RATE_LIMITED').length).toBeGreaterThan(0);
    expect(s.fc.requests.length).toBeLessThanOrEqual(101);
  });

  it('sub/unsub are forwarded for the frame app only', async () => {
    const s = setup();
    s.frame.load();
    s.bridge.onWindowMessage({ source: s.frame.contentWindow, data: s.hello });
    const port = s.port();
    await talk(port, { t: 'sub' });
    await talk(port, { t: 'unsub' });
    expect(s.fc.subs).toEqual(['+echo', '-echo']);
  });
});
