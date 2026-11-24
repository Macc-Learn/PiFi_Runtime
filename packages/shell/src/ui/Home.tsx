/** Home: the paired Pis (Phase 3 §9.2 screen 4). */
import { useEffect, useState } from 'preact/hooks';

function iosHint(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  try {
    return ios && !standalone && localStorage.getItem('pifi.iosHint') !== 'seen';
  } catch {
    return false;
  }
}

export function Home(props: { pis: Array<{ deviceId: string; label: string }> }): preact.JSX.Element {
  const [hint, setHint] = useState(false);
  useEffect(() => setHint(props.pis.length > 0 && iosHint()), [props.pis.length]);
  return (
    <main>
      <h1>PiFi</h1>
      {hint && (
        <div class="card" role="note">
          <p>On iPhone, Safari may delete this site's data after about a week without use, including your key. Add PiFi to your Home Screen (Share → Add to Home Screen) to keep it.</p>
          <button onClick={() => { try { localStorage.setItem('pifi.iosHint', 'seen'); } catch { /* ignore */ } setHint(false); }}>Got it</button>
        </div>
      )}
      {props.pis.length === 0 ? (
        <div class="card"><p>No Pi paired yet. On your Pi, run <code>pifi pair</code> and scan the QR code with this phone.</p></div>
      ) : (
        props.pis.map((p) => (
          <a key={p.deviceId} class="card row" href={`#/pi/${p.deviceId}`}>
            <span><strong>Pi {p.deviceId.slice(0, 8)}</strong><br /><span class="muted">this phone: {p.label}</span></span>
            <span aria-hidden="true">›</span>
          </a>
        ))
      )}
    </main>
  );
}
