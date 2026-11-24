/** An app's own page, in a sandboxed frame (Phase 3 §9.2 screen 3, §10). */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConnectionManager } from '../core/connection.js';
import { FRAME_SANDBOX, FrameBridge } from '../core/frames.js';
import { needsConsent, recordConsent, type PiRecord, type ShellStore } from '../core/store.js';
import { useConn } from './Dashboard.js';

interface AppItem { name: string; displayName?: string; frontend?: string }

export function AppView(props: { pi: PiRecord; conn: ConnectionManager; store: ShellStore; app: string }): preact.JSX.Element {
  const status = useConn(props.conn);
  const [info, setInfo] = useState<AppItem>();
  const [consent, setConsent] = useState<'unknown' | 'ask' | 'granted'>('unknown');
  const [warning, setWarning] = useState<string>();
  const holder = useRef<HTMLDivElement>(null);

  // Learn the app's front-end URL from the Pi.
  useEffect(() => {
    if (status.state !== 'online' || info) return;
    props.conn.request('apps.list').then((list) => {
      const a = (list as AppItem[]).find((x) => x.name === props.app);
      if (!a?.frontend) return setWarning('This app has no front-end.');
      setInfo(a);
      void needsConsent(props.store, props.pi.deviceId, a.name, a.frontend).then((need) => setConsent(need ? 'ask' : 'granted'));
    }, () => setWarning('Could not load the app list.'));
  }, [status.state, info, props.app]);

  // Create the frame imperatively: the sandbox attributes must be exact, and the bridge must see its first load.
  useEffect(() => {
    if (consent !== 'granted' || !info?.frontend || !holder.current) return;
    const url = new URL(info.frontend);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      setWarning('Refusing to open a non-https front-end.');
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'appframe';
    frame.setAttribute('sandbox', FRAME_SANDBOX); // never allow-same-origin / allow-top-navigation / allow-popups
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', '');
    frame.title = info.displayName ?? info.name;
    const bridge = new FrameBridge({
      app: info.name, // the frame is bound to THIS app; the page can't change it
      frame,
      client: () => props.conn.client,
      onStatus: (cb) => props.conn.onStatus(cb),
      onDestroyed: (reason) => setWarning(`The app page was closed: ${reason}.`),
    });
    const onMessage = (ev: MessageEvent): void => bridge.onWindowMessage(ev);
    window.addEventListener('message', onMessage);
    frame.src = url.toString();
    holder.current.appendChild(frame);
    return () => { window.removeEventListener('message', onMessage); bridge.destroy('closed'); };
  }, [consent, info]);

  const origin = info?.frontend ? new URL(info.frontend).origin : '';
  return (
    <div class="appview">
      <div class="topbar">
        <a class="button" href={`#/pi/${props.pi.deviceId}`} aria-label="Back to dashboard">‹</a>
        <span class="title">{info?.displayName ?? props.app}</span>
        <span class={`dot ${status.state === 'online' ? 'online' : ''}`} role="img" aria-label={status.state === 'online' ? 'connected' : 'reconnecting'} />
      </div>
      {status.state !== 'online' && <div class="bar" role="status">Reconnecting…</div>}
      {warning && <main><div class="card error" role="alert">{warning}</div></main>}
      {consent === 'ask' && info && (
        <main>
          <div class="card">
            <p>Open <span class="host">{origin}</span> inside PiFi?</p>
            <p>This page can send requests to the <strong>{info.displayName ?? info.name}</strong> app on your Pi. It cannot see your keys or your other apps.</p>
            <div class="actions">
              <button class="primary" onClick={() => void recordConsent(props.store, props.pi.deviceId, info.name, info.frontend as string).then(() => setConsent('granted'))}>Open</button>
              <a class="button" href={`#/pi/${props.pi.deviceId}`}>Cancel</a>
            </div>
          </div>
        </main>
      )}
      <div ref={holder} style={{ flex: '1', display: 'flex' }} />
    </div>
  );
}
