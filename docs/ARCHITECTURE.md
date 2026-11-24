# How PiFi works (Phase 1)

PiFi is a **building manager** for apps on a Raspberry Pi. It doesn't do the
apps' work; it starts them, keeps an eye on them, introduces them to whoever
wants to talk to them, and shuts them down properly.

```
  you (CLI / curl)                                   apps (separate processes)
        │  HTTP + admin token                              ▲
        ▼                                                  │ WebSocket + per-launch token
 ┌─────────────────────── PiFi daemon (one Node process) ───────────────────┐
 │  controlApi ──► appManager ◄── localServer (ws://127.0.0.1:7777/app)     │
 │                     │  ▲                                                 │
 │          registry ──┘  └── router (request id ⇄ response)               │
 │          state.json / pids.json / logs                                   │
 └───────────────────────────────────────────────────────────────────────────┘
```

Phase 1 has no phone, no internet and no WebRTC. The control API stands in for
"the phone asked PiFi to do something", so everything can be tested locally.

## The pieces (one file each, in `packages/runtime/src`)

| File | Job |
|---|---|
| `registry.ts` | Find `registered-apps/*/pifi.json`, validate with zod, compute/verify the folder hash |
| `appManager.ts` | The heart: start / stop / restart / crash handling, owns every `AppRecord` |
| `appRecord.ts` | The per-app record type and its state machine |
| `localServer.ts` | The WebSocket server apps connect to; all the token/Origin/hello checks |
| `router.ts` | Matches a `response` to the `request` that caused it |
| `controlApi.ts` + `cli.ts` | How a human drives PiFi in Phase 1 |
| `resources.ts`, `ports.ts` | RAM check, free-port allocation |
| `state.ts` | `state.json` (what should run) and `pids.json` (orphan cleanup), written atomically |
| `daemon.ts`, `index.ts` | Wiring and signal handling |
| `identity.ts`, `pairing.ts`, `qr.ts` | Device keypair, one-time pairing codes, QR rendering |
| `signalingClient.ts` | Outbound connection to the signaling server (Phase 2) |
| `pairHandler.ts`, `pairedStore.ts` | Phone pairing and the paired-phones file (Phase 3) |
| `sessions.ts`, `wireSession.ts`, `peer.ts` | Session handshake, data-channel router, WebRTC transport (Phase 3) |
| `appStreams.ts` | Byte streams between PiFi and an app process (Phase 3) |

`packages/protocol` holds the message shapes (shared by the runtime and the
SDK). `packages/sdk` is the small library apps use.

## Life of an app

States: `stopped → starting → running → stopping → stopped`, plus `crashed`
(died unexpectedly, may be restarted) and `failed` (PiFi gave up).

### Starting (`pifi start echo`)

1. The control API receives `POST /apps/echo/start` and calls `appManager.start`.
2. State becomes `starting` **immediately** (before any `await`), so a second
   `start` arriving a millisecond later waits for this one instead of launching
   a duplicate.
3. Checks, in order: hash matches (skipped in `--dev`) → enough free RAM →
   allocate a port if `needsPort`. Failing any of them sets state `failed` with
   a reason and spawns nothing.
4. PiFi generates a random **token** and spawns the process with
   `shell: false`, a minimal environment, and `PIFI_URL`, `PIFI_APP_NAME`,
   `PIFI_APP_TOKEN`. Its output is captured into a 200-line ring buffer and
   `logs/<name>.log`.
5. The app connects to `PIFI_URL`. `localServer` insists the **first** message
   is `hello` carrying the token, within 3 s. The token is checked in constant
   time; PiFi answers `welcome`.
6. The app sends `ready`. State becomes `running` and the `start` call returns.
   If `ready` hasn't arrived within `startTimeoutMs`, PiFi SIGKILLs the process
   and the state becomes `failed` ("start timeout").

### A request (`pifi send echo '{"hi":1}'`)

`appManager.request` asks the app's `Router` for a fresh id and a pending
Promise, sends `{type:"request", id, payload}`, and waits. The app replies with
`{type:"response", id, payload}`; `localServer` hands it to `appManager`, which
calls `router.settle(id, …)`, resolving the Promise. No reply within 10 s
rejects the Promise and deletes the pending entry. In later phases a phone's
command will be forwarded through exactly this path.

### Stopping (`pifi stop echo`)

Polite, then firm, then forceful:

1. Send a `shutdown` message. The app gets 5 s to finish and exit.
2. Still alive? `SIGTERM`, 5 s more.
3. Still alive? `SIGKILL` (can't be ignored).

`stop --hard` skips straight to `SIGKILL`. On Windows there is no real
`SIGTERM`; `child.kill()` terminates immediately, so only step 1 is graceful.

### The one rule that keeps this correct

**The child process's `exit` event is the only thing that decides an app's
final state.** `stop()` and the start timeout don't set `stopped`/`failed`
directly; they set a flag saying *why* an exit is expected (`stopRequested`,
`killReason`) and wait. `onExit` then reads the flags:

- `stopRequested` → `stopped` (a deliberate stop is never a crash, so no restart)
- `killReason` (start timeout) → `failed`
- otherwise → it crashed: restart with backoff (1 s, 2 s, 4 s) up to
  `maxRestarts` per `windowSec`, then `failed`

`onExit` also frees everything tied to that process: the token, the port, the
socket, pending requests, the pid entry, timers.

## Why these security choices

- **127.0.0.1 only**: the port is invisible outside the Pi.
- **Reject `Origin`**: browsers attach it to WebSocket and fetch requests; our
  own apps never do. A malicious web page therefore can't use your browser as a
  stepping stone to the local port.
- **Per-launch token**: a different local process can't pretend to be `echo`.
- **Hash before launch**: a changed file can't run silently.
- **No shell**: `spawn(cmd, [args])` hands arguments straight to the OS, so
  there's nothing to inject into.

See `SECURITY.md` for what is and isn't covered.

## Writing an app in any language

You don't need the SDK. Connect to `PIFI_URL` and speak JSON text frames.
Every message is `{ "v": 1, "type": ..., "id"?: ..., "payload"?: ..., "error"?: {code, message} }`.

App → PiFi:

| type | fields | meaning |
|---|---|---|
| `hello` | `payload: {name, token, sdkVersion}` | **must be first** |
| `ready` | | initialised, can take requests |
| `response` | `id`, `payload` or `error` | answer to a `request` |
| `event` | `payload: {name, data}` | unsolicited message |
| `log` | `payload: {level, message}` | structured log line |

PiFi → app: `welcome {name}`, `request {id, payload}`,
`shutdown {graceMs, reason}`, `error {error}` (then PiFi closes the socket).

Close codes: `4001` bad/missing token · `4002` duplicate connection ·
`4003` unknown app · `4004` Origin header present · `4005` protocol violation
(bad JSON, first message not `hello`, no `hello` within 3 s). An oversized
frame (> 1 MiB) is closed by the `ws` library with the standard `1009`.
On `shutdown`: clean up and exit `0`. If the socket closes, exit non-zero.

## Device identity and pairing (Phase 1 revision)

PiFi has no accounts. Identity is a keypair.

- `identity.ts` creates `keys/identity.key` (PKCS#8, `0600`) and `identity.pub`
  (SPKI) on first start, in a `0700` folder, written temp-file-then-rename so a
  crash can't leave half a key. If only one file exists, or the two don't
  match, the daemon **refuses to start**: silently making a new key would change
  the device's identity and unpair every phone.
- `deviceId = base32(sha256(SPKI DER))`, lowercase, no padding, 52 characters.
  The code is in `packages/protocol/src/crypto.ts` so the Pi and the signaling
  server compute it identically. A browser does the same with `exportKey('spki')`,
  `digest('SHA-256')` and base32. A fixed test vector lives in `packages/protocol/test`.
- ECDSA P-256 with IEEE P1363 (raw 64-byte) signatures, because that is what
  WebCrypto in every browser speaks.
- The private key sits in a closure inside the `Identity` object. There is no
  property to print, so `JSON.stringify`, logs and API responses can't leak it.

`pairing.ts` holds at most one pairing code: 16 random bytes (base64url), with a
TTL. `POST /pair` returns it once; `GET /pair` never does. The CLI turns it into
`<frontend>/pair#id=<deviceId>&s=<secret>` and a QR code. The secret goes after
`#` because browsers never send the fragment to any server.

## Signaling client (Phase 2)

`signalingClient.ts` is the daemon's only outbound connection (see
[signaling.md](signaling.md) for the wire protocol). Its states are
`disabled → connecting → authenticating → online`, and `backoff` after any drop.

1. Open `PIFI_SIGNAL_URL`, send `pi.hello {deviceId, publicKey}`.
2. The server answers `challenge {nonce}`; the client signs
   `"pifi-register-v1" + nonce + deviceId` with the identity key.
3. `registered` → `online`. Pings every 25 s, so a dead server is noticed.
4. On a drop, the close code decides the wait: 4100 (server redeploying) →
   random 0–3 s; 4011 (another connection took over this identity) → ≥ 30 s, and
   give up after 3 in a row; 4010 (rejected) → max backoff; anything else →
   exponential backoff 1 s → 30 s with ±20% jitter, reset after 60 s online.

The daemon starts the client *after* everything else is listening and never
waits for it, so a missing or broken server can't stop apps from running.
Incoming relays are dropped in Phase 2, except a dev-only echo
(`PIFI_DEV=1`, payload `{"kind":"echo"}`) used by the test client.

## Phones, sessions and the shell (Phase 3)

```
 phone (shell site)                         Raspberry Pi (PiFi daemon)
 ┌───────────────────────┐   WebRTC data    ┌────────────────────────────────────┐
 │ connection manager ───┼──── channel ─────┼─ sessions.ts ─ wireSession.ts ─┐   │
 │  ▲  MessagePort       │  (direct, DTLS)  │   control ops (apps.*, phones.*)│   │
 │ ┌┴─────────────────┐  │                  │   app requests/events/streams ──┼─► app processes
 │ │ sandboxed iframe │  │   signaling      │ pairHandler.ts, pairedStore.ts  │   (localhost WS)
 │ │ app page +       │  │  (only to pair   │ peer.ts (node-datachannel)      │   │
 │ │ @pifi/client     │  │  and set up)     └────────────────────────────────────┘
 │ └──────────────────┘  │
 └───────────────────────┘
```

**Pairing** (once): the QR link carries the Pi's deviceId and a one-time secret.
The phone makes a key for that Pi, proves it knows the secret with an HMAC, and
the Pi proves it holds the key behind the deviceId by signing the phone's
challenge. `pairHandler.ts` stores the phone's public key in `paired.json`.

**A session** (every connection): `sessions.ts` answers `session.hello` with a
challenge, checks the phone's signature over its offer's DTLS fingerprint, and
only then asks `peer.ts` for a WebRTC peer connection. It signs its own answer's
fingerprint the same way. When the data channel opens, `wireSession.ts` routes
frames: control ops are handled by PiFi itself; `req` with an `app` becomes that
app's Phase 1 `request {op, payload}`; app `event`s go to sessions that sent
`sub`; streams are bridged to the app's localhost socket (`appStreams.ts`) as
`[u32 sid][bytes]` binary frames, with half-close and backpressure (PiFi pauses
reading an app's socket while a phone's channel is backed up).

**The shell** (`packages/shell`) is a static site. Its `core/` folder has no UI
and runs in Node too: the end-to-end test and `signal-testclient`'s fake phone
use the very same pairing, session and wire code as phones. App pages run in a
sandboxed frame; `frames.ts` hands each one a `MessagePort` and forwards its
requests with `app` set by the shell, so a page can only ever reach its own app.

Details: [wire-protocol.md](wire-protocol.md), [shell.md](shell.md),
[app-frontends.md](app-frontends.md).

## Deliberate Phase 1 simplifications

- Memory limits are checked at start, not enforced.
- The app hash skips `node_modules`.
- Control API is HTTP on loopback (a Unix socket may replace it later).
- No reconnect in the SDK: if PiFi vanishes, the app exits.
