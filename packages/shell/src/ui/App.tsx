/** Top-level state: storage, the paired Pis, one connection per Pi, hash routing. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { browserEnv } from '../core/env.js';
import { isShellError } from '../core/errors.js';
import { ConnectionManager } from '../core/connection.js';
import { checkKey, IndexedDbStore, type PiRecord, type ShellStore } from '../core/store.js';
import { ICE_SERVERS, SIGNAL_URL } from './config.js';
import { messageFor } from './messages.js';
import { PairScreen } from './PairScreen.js';
import { Home } from './Home.js';
import { Dashboard } from './Dashboard.js';
import { AppView } from './AppView.js';

export const env = browserEnv();

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = (): void => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

/** Shell root URL (works under a GitHub project path). */
export const shellRoot = (): string => new URL(import.meta.env.BASE_URL, location.origin).toString();

export function App(props: { pairPage: boolean; pairTarget?: { deviceId: string; secret: string } }): preact.JSX.Element {
  const [store, setStore] = useState<ShellStore>();
  const [storageError, setStorageError] = useState<string>();
  const [pis, setPis] = useState<PiRecord[]>([]);
  const [current, setCurrent] = useState<string>();
  const hash = useHash();
  const conns = useMemo(() => new Map<string, ConnectionManager>(), []);

  useEffect(() => {
    IndexedDbStore.open().then(
      async (s) => { setStore(s); setPis(await s.listPis()); },
      (e) => setStorageError(isShellError(e) ? e.code : 'STORAGE_UNAVAILABLE'),
    );
  }, []);

  // Reconnect at once when the tab becomes visible again or the network comes back.
  useEffect(() => {
    const kick = (): void => { if (document.visibilityState === 'visible') for (const c of conns.values()) c.reconnectNow(); };
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('online', kick);
    return () => { document.removeEventListener('visibilitychange', kick); window.removeEventListener('online', kick); };
  }, [conns]);

  const connFor = (pi: PiRecord): ConnectionManager => {
    let c = conns.get(pi.deviceId);
    if (!c) {
      c = new ConnectionManager({ pi, signalUrl: SIGNAL_URL, iceServers: ICE_SERVERS, env });
      conns.set(pi.deviceId, c);
      c.start();
    }
    return c;
  };

  const forget = async (deviceId: string): Promise<void> => {
    conns.get(deviceId)?.stop();
    conns.delete(deviceId);
    await store?.deletePi(deviceId);
    setPis((await store?.listPis()) ?? []);
    location.hash = '#/';
  };

  if (storageError) return <main><div class="card error"><p>{messageFor(storageError)}</p></div></main>;
  if (!store) return <main><p class="muted">Loading…</p></main>;

  if (props.pairPage) {
    return <PairScreen store={store} target={props.pairTarget} onPaired={(id) => { location.href = `${shellRoot()}#/pi/${id}`; }} />;
  }

  const piRoute = /^#\/pi\/([a-z2-7]{52})$/.exec(hash);
  const appRoute = /^#\/app\/([a-z0-9][a-z0-9-]{0,31})$/.exec(hash);
  const byId = (id: string | undefined): PiRecord | undefined => pis.find((p) => p.deviceId === id);

  if (appRoute) {
    const pi = byId(current);
    if (!pi) { location.hash = '#/'; return <main />; }
    return <AppView pi={pi} conn={connFor(pi)} store={store} app={appRoute[1] as string} />;
  }
  if (piRoute) {
    const pi = byId(piRoute[1]);
    if (!pi) return <main><div class="card">Unknown Pi. <a href="#/">Back</a></div></main>;
    if (current !== pi.deviceId) setCurrent(pi.deviceId);
    try {
      checkKey(pi);
    } catch {
      return <main><div class="card error"><p>{messageFor('KEY_MISSING')}</p><button class="danger" onClick={() => void forget(pi.deviceId)}>Forget this Pi</button></div></main>;
    }
    return <Dashboard pi={pi} conn={connFor(pi)} onForget={() => void forget(pi.deviceId)} />;
  }
  return <Home pis={pis} />;
}
