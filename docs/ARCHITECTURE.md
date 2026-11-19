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

## Deliberate Phase 1 simplifications

- Memory limits are checked at start, not enforced.
- The app hash skips `node_modules`.
- Control API is HTTP on loopback (a Unix socket may replace it later).
- No reconnect in the SDK: if PiFi vanishes, the app exits.
