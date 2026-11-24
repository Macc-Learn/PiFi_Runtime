/** "Pair this phone" (Phase 3 §9.2 screen 1). */
import { useState } from 'preact/hooks';
import { isShellError } from '../core/errors.js';
import { pairAndSave, type PairStep, type StepState } from '../core/pairing.js';
import type { ShellStore } from '../core/store.js';
import { env } from './App.js';
import { SIGNAL_URL } from './config.js';
import { messageFor } from './messages.js';

const STEPS: Array<[PairStep, string]> = [
  ['server', 'Reach the PiFi server'],
  ['online', 'Your Pi is online'],
  ['key', 'Create a key for this phone'],
  ['verify', "Check your Pi's identity"],
];
const MARK: Record<StepState | 'idle', string> = { idle: '○', active: '…', done: '✓', failed: '✕' };

export function PairScreen(props: { store: ShellStore; target?: { deviceId: string; secret: string }; onPaired: (id: string) => void }): preact.JSX.Element {
  const [label, setLabel] = useState('My phone');
  const [steps, setSteps] = useState<Record<PairStep, StepState | 'idle'>>({ server: 'idle', online: 'idle', key: 'idle', verify: 'idle' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [abort, setAbort] = useState<AbortController>();
  const { target } = props;

  if (!target) {
    return <main><h1>Pair this phone</h1><div class="card error"><p>This page needs a pairing link. On your Pi, run <code>pifi pair</code> and scan the QR code.</p></div></main>;
  }

  const start = async (): Promise<void> => {
    const ac = new AbortController();
    setAbort(ac); setBusy(true); setError(undefined);
    try {
      const rec = await pairAndSave(props.store, {
        deviceId: target.deviceId, secret: target.secret, label, signalUrl: SIGNAL_URL, env, signal: ac.signal,
        onStep: (s, st) => setSteps((prev) => ({ ...prev, [s]: st })),
        onOffline: () => setError('PI_OFFLINE'),
      });
      await navigator.storage?.persist?.().catch(() => false); // ask the browser not to evict our key
      props.onPaired(rec.deviceId);
    } catch (e) {
      setError(isShellError(e) ? e.code : 'SERVER_UNREACHABLE');
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>Pair this phone</h1>
      <p>You are on <span class="host">{location.host}</span>. Only continue if this is the address you expected.</p>
      <div class="card">
        <p class="muted">Pi</p>
        <p class="mono">{target.deviceId.slice(0, 8)}…{target.deviceId.slice(-4)}</p>
        <label for="label">Name for this phone</label>
        <input id="label" type="text" maxLength={40} value={label} disabled={busy} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
      </div>
      <ul class="steps" aria-live="polite">
        {STEPS.map(([key, text]) => (
          <li key={key}><span class={`mark ${steps[key]}`} aria-hidden="true">{MARK[steps[key]]}</span><span>{text}</span></li>
        ))}
      </ul>
      {error && <div class="card error" role="alert"><p>{messageFor(error)}</p></div>}
      <div class="actions">
        <button class="primary" disabled={busy} onClick={() => void start()}>Pair</button>
        <button disabled={!busy} onClick={() => { abort?.abort(); setBusy(false); }}>Cancel</button>
      </div>
      <p class="muted">Privacy: your phone creates its own key and shares only the public half with your Pi. The PiFi server only introduces the two; it never sees your files, your keys or your pairing code.</p>
    </main>
  );
}
