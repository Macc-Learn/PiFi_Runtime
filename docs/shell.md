# The shell (`packages/shell`)

The shell is a static web app (Vite + Preact, no other runtime dependencies) that:

- holds this phone's keys (one per paired Pi),
- pairs with a Pi from the QR code,
- owns the single direct WebRTC connection to each Pi,
- shows the dashboard (apps, paired phones),
- runs each app's own web page in a sandboxed frame.

## Structure

```
packages/shell/
  index.html, pair/index.html   two entries, one bundle (pair mode = /pair/)
  public/                       manifest.webmanifest, icons
  src/core/                     no UI: also runs in Node (the fake phone)
    pairing.ts                  QR fragment -> pair.request -> verify Pi -> PiRecord
    session.ts                  signed handshake -> RTCPeerConnection -> data channel
    wireClient.ts               requests, events, streams, heartbeat
    connection.ts               reconnect/backoff state machine for one Pi
    frames.ts                   sandboxed app frame <-> MessagePort bridge
    store.ts                    IndexedDB (and an in-memory store for tests), consent
    phoneCrypto.ts, signal.ts, env.ts, errors.ts
  src/ui/                       Preact screens: Pair, Home, Dashboard, AppView
  test/                         Vitest (happy-dom)
```

Routes (hash): `#/` home, `#/pi/<deviceId>` dashboard, `#/app/<name>` app view.
The QR link `<frontend>/pair#id=…&s=…` opens `pair/index.html`, which reads the
fragment and **erases it** (`history.replaceState`) before anything else runs.

## Storage (IndexedDB `pifi`)

| store | record |
|---|---|
| `pis` | `{deviceId, piSpki, label, keyPair, phoneId, createdAt, lastUsedAt}` |
| `trustedFrontends` | `{deviceId, app, origin}` |

`keyPair.privateKey` is a **non-extractable** WebCrypto key: it can sign, but
neither the page nor anything else can read it out. After the first pairing the
shell calls `navigator.storage.persist()`. On iOS Safari (outside the Home
Screen app) site data may be deleted after about 7 days of disuse; the home
screen shows a one-time "Add to Home Screen" hint. A record whose key is gone
shows `KEY_MISSING` with a "Forget this Pi" button; it never crashes.

## Connection states

`idle → connecting → online → reconnecting → online …`, or `offline` for
problems only re-pairing can fix (`NOT_PAIRED`, `KEY_MISSING`, `BAD_ANSWER`).
Backoff 1 s → 30 s with ±20% jitter, reset after 60 s online; immediate retry
when the tab becomes visible, the network comes back, or a heartbeat is missed.
App frames stay open while reconnecting; their requests fail with `DISCONNECTED`
until the connection is back (nothing is retried automatically).

| state shown | when |
|---|---|
| `PI_OFFLINE` | Pi not connected to the server (pairing retries every 5 s up to 60 s) |
| `REJECTED` | pairing code wrong, expired or used |
| `NOT_GENUINE` | the Pi couldn't prove it holds the key behind the QR's device ID |
| `NOT_PAIRED` | the Pi doesn't know this phone (revoked) |
| `UNREACHABLE` | no direct path after 15 s (no TURN in Phase 3) |
| `SERVER_UNREACHABLE` | signaling server unreachable |
| `KEY_MISSING`, `STORAGE_UNAVAILABLE` | browser storage problems |

## Build-time configuration

`VITE_SIGNAL_URL`, `VITE_ICE_SERVERS`, `VITE_BASE` (see `.env.example`). The
signaling URL is **only** set at build time: a page URL or QR code can never
point the shell at a different server.

## Content Security Policy

GitHub Pages can't send headers, so the policy is a `<meta>` tag:
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self' <signaling origin>; frame-src https: http://localhost:*
http://127.0.0.1:*; base-uri 'none'; form-action 'none'; object-src 'none'`,
plus `<meta name="referrer" content="no-referrer">`. No inline scripts, no
`innerHTML` with data, no `eval`; nothing is loaded from third parties.

## Testing

- `npm run -s test -w @pifi/shell`: Vitest. Pairing against a fake Pi, the
  shared crypto vectors under WebCrypto, session verification, reconnect and
  backoff, frame handoff rules, consent, `KEY_MISSING`.
- `npm run smoke:browser`: the built shell in headless Chromium against a real
  daemon and signaling server (needs Playwright + Chromium). Pairs, connects
  directly, opens the echo page, and checks the sandbox from inside the frame.

## Manual test checklist (real phones)

Do these on **iPhone Safari** and **Android Chrome**:

- [ ] Run `pifi pair`, scan the QR, pair. The address bar no longer shows `#id=…&s=…`.
- [ ] The pair page shows the host name prominently; it is the one you expected.
- [ ] Dashboard shows "Online · Direct connection"; start, stop, restart echo.
- [ ] Lock the phone for a minute, unlock: it reconnects by itself.
- [ ] Switch from Wi-Fi to mobile data with the dashboard open: it reconnects
      (or shows "Couldn't connect directly" on networks that block P2P).
- [ ] Add to Home Screen; open from the icon; still paired.
- [ ] From a second paired phone, revoke the first: the first shows "Pair again".
- [ ] Open the echo front-end: consent prompt shows its origin; request, events
      and the stream test all work.
- [ ] Hostile page test: register an app whose `frontend` is a page that tries to
      navigate itself, read `localStorage`, reach `window.parent`, and send
      `apps.stop` requests. Expected: the frame is destroyed on navigation,
      storage and parent access throw, and requests only reach that app.
