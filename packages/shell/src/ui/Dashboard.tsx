/** Dashboard for one Pi (Phase 3 §9.2 screen 2). */
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ConnStatus, ConnectionManager } from '../core/connection.js';
import type { PiRecord } from '../core/store.js';
import { messageFor } from './messages.js';

interface AppItem { name: string; displayName?: string; description?: string; state: string; frontend?: string }
interface Phone { phoneId: string; label: string; lastSeenAt: number; connected: boolean; current?: boolean }

export function useConn(conn: ConnectionManager): ConnStatus {
  const [s, setS] = useState(conn.state);
  useEffect(() => conn.onStatus(setS), [conn]);
  return s;
}

export function Dashboard(props: { pi: PiRecord; conn: ConnectionManager; onForget: () => void }): preact.JSX.Element {
  const { conn } = props;
  const status = useConn(conn);
  const [apps, setApps] = useState<AppItem[]>([]);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [name, setName] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [st, a, p] = await Promise.all([conn.request('status'), conn.request('apps.list'), conn.request('phones.list')]);
      setName((st as { deviceName?: string }).deviceName);
      setApps(a as AppItem[]);
      setPhones(p as Phone[]);
      setError(undefined);
    } catch (e) {
      setError((e as { code?: string }).code);
    }
  }, [conn]);

  useEffect(() => { if (status.state === 'online') void refresh(); }, [status.state, refresh]);

  const act = async (op: string, payload: Record<string, string>): Promise<void> => {
    setBusy(op + JSON.stringify(payload));
    try { await conn.request(op, payload); } catch (e) { setError((e as { code?: string }).code); }
    setBusy(undefined);
    void refresh();
  };

  const label = status.state === 'online' ? 'Online · Direct connection' : status.state === 'offline' ? 'Offline' : 'Connecting…';
  return (
    <main>
      <a href="#/">‹ All Pis</a>
      <h1>{name ?? `Pi ${props.pi.deviceId.slice(0, 8)}`}</h1>
      <p class={`state-${status.state}`} aria-live="polite">● {label}</p>
      {status.state !== 'online' && status.reason && (
        <div class={`card ${status.state === 'offline' ? 'error' : ''}`}>
          <p>{messageFor(status.reason)}</p>
          {status.state === 'offline' ? <button class="danger" onClick={props.onForget}>Forget this Pi</button> : <button onClick={() => conn.reconnectNow()}>Retry now</button>}
        </div>
      )}
      {error && <div class="card error" role="alert"><p>{messageFor(error)} ({error})</p></div>}

      <h2>Apps</h2>
      {apps.length === 0 && <p class="muted">No apps registered.</p>}
      {apps.map((a) => (
        <div class="card" key={a.name}>
          <div class="row">
            <span><strong>{a.displayName ?? a.name}</strong><br /><span class="muted">{a.state}{a.description ? ` · ${a.description}` : ''}</span></span>
            <span class="actions">
              {a.frontend
                ? <a class="button primary" href={`#/app/${a.name}`} aria-disabled={a.state !== 'running'}>Open</a>
                : <button disabled>No front-end</button>}
              {a.state === 'running'
                ? <><button disabled={!!busy} onClick={() => void act('apps.restart', { name: a.name })}>Restart</button><button disabled={!!busy} onClick={() => void act('apps.stop', { name: a.name })}>Stop</button></>
                : <button disabled={!!busy || status.state !== 'online'} onClick={() => void act('apps.start', { name: a.name })}>Start</button>}
            </span>
          </div>
        </div>
      ))}

      <h2>Paired phones</h2>
      {phones.map((p) => (
        <div class="card row" key={p.phoneId}>
          <span><strong>{p.label}</strong>{p.current ? ' (this phone)' : ''}<br /><span class="muted">{p.connected ? 'connected' : `last seen ${new Date(p.lastSeenAt).toLocaleString()}`}</span></span>
          {!p.current && <button class="danger" onClick={() => { if (confirm(`Remove "${p.label}"? It will need to pair again.`)) void act('phones.revoke', { phoneId: p.phoneId }); }}>Revoke</button>}
        </div>
      ))}
      <h2>This phone</h2>
      <button class="danger" onClick={() => { if (confirm('Forget this Pi on this phone? You will need to pair again.')) props.onForget(); }}>Forget this Pi</button>
    </main>
  );
}
