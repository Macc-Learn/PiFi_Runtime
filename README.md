# PiFi

PiFi is an app runtime for your Raspberry Pi: a self-hosted app platform you can reach from your phone, without opening any router ports.
Think of it as a building manager for your Pi's apps. It starts them, watches them, restarts them if they crash, stops them cleanly, and lets nothing reach them except through PiFi. Apps are separate processes in any language, and they talk to PiFi over a localhost-only WebSocket.
Your Pi dials out to a small signaling server, and your phone connects to it directly over WebRTC. The first planned app is a NAS-style file store.

> **Experimental, not security-audited.** See [SECURITY.md](SECURITY.md).

**Status: Phase 3.**

- **Phase 1:** app-management core (registry, supervision, control API, CLI, SDK).
- **Phase 1 revision:** device identity (ECDSA P-256 key, `deviceId`) and pairing QR codes.
- **Phase 2:** a signaling server (`packages/server`), the Pi's outbound signaling client,
  and a fake-phone CLI (`packages/signal-testclient`). A Pi is now reachable *as online*
  without opening any port.
- **Phase 3:** phones pair by scanning the QR, then connect **directly** to the Pi
  over WebRTC (signed handshake bound to the DTLS fingerprints). The shell site
  (`packages/shell`) shows the Pi's apps, starts and stops them, manages paired
  phones, and opens each app's own web page in a sandboxed frame; app pages use
  `@pifi/client`. Apps gained events and byte streams. The signaling server was hardened.

Not built yet: TURN relay, roles/permissions, an app lock, the files app (it will
be its own repo), a custom domain, GPIO, Wi-Fi provisioning.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) (how the code works) ·
[MANIFEST](docs/MANIFEST.md) · [signaling](docs/signaling.md) ·
[wire protocol](docs/wire-protocol.md) · [shell](docs/shell.md) ·
[app front-ends](docs/app-frontends.md) · [Pages deploy](docs/deploy-shell-pages.md) ·
[Cloud Run deploy](docs/deploy-cloud-run.md) · [Pi + systemd](docs/deploy-pi-systemd.md)

## Requirements

Node.js 20+ (22 LTS recommended). Works on Linux, macOS and Windows for
development; the target is Raspberry Pi OS Lite 64-bit. On Windows, stopping
an app is always a hard kill (no `SIGTERM`), and the RAM check falls back to
`os.freemem()`.

## Install, build, test

```bash
npm install
npm run build      # tsc -b (strict TypeScript, output in each package's dist/)
npm test           # builds, then runs the whole suite with node:test
```

## Run the daemon and the echo demo

Use dev mode so data lives in `./pifi-data` and hash checks are skipped:

```bash
export PIFI_DEV=1                       # (Windows PowerShell: $env:PIFI_DEV = "1")
npm run demo:register                   # copies examples/echo-app into ./pifi-data/registered-apps/echo
alias pifi="node $PWD/packages/runtime/dist/src/cli.js"

pifi daemon                             # terminal 1; Ctrl+C stops it and all apps

# terminal 2 (with PIFI_DEV=1 exported there too):
pifi list
pifi start echo
pifi send echo '{"hello":"pi"}'
pifi logs echo
pifi stop echo
```

Real transcript from a smoke test of this build:

```
$ pifi list
NAME  STATE    PID  PORT  UPTIME  RESTARTS  NOTE
echo  stopped  -    -     -       0
$ pifi start echo
{ "name": "echo", "version": "1.0.0", "state": "running", "pid": 1746, ... }
$ pifi send echo '{"hello":"pi"}'
{ "payload": { "echoed": { "hello": "pi" }, "at": 1795107565286 } }
$ pifi list
NAME  STATE    PID   PORT  UPTIME  RESTARTS  NOTE
echo  running  1746  -     0s      0
$ pifi logs echo
echo: ready
echo: got request {"hello":"pi"}
$ pifi stop echo
{ "name": "echo", "state": "stopped", ... }
```

### Phase 3: pair a phone and connect directly

```bash
npm run build
PORT=8080 npm run signal-server                                         # terminal 1
PIFI_DEV=1 PIFI_SIGNAL_URL=ws://localhost:8080/ws pifi daemon            # terminal 2

# terminal 3: a fake phone that runs the shell's own code in Node
LINK=$(pifi pair --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).link')
npm run -s signal-testclient -- pair "$LINK" --url ws://localhost:8080/ws
npm run -s signal-testclient -- apps --url ws://localhost:8080/ws
npm run -s signal-testclient -- call apps.start '{"name":"echo"}' --url ws://localhost:8080/ws
npm run -s signal-testclient -- call echo '{"hi":1}' --app echo --url ws://localhost:8080/ws
pifi devices list
```

With a real phone, build the shell for your signaling server and serve it
(`VITE_SIGNAL_URL=wss://… npm run build:shell`, then host `packages/shell/dist`
over https), or publish it with the Pages workflow
([docs/deploy-shell-pages.md](docs/deploy-shell-pages.md)), and scan the QR
from `pifi pair --frontend https://your-shell-host`. A phone needs to reach
the signaling server over `wss://`, and the shell must be served over https
(or from localhost) for WebCrypto to be available.

`npm run smoke:browser` runs the whole flow in headless Chromium on this
machine (needs Playwright + Chromium).

### CLI reference

| Command | What it does |
|---|---|
| `pifi daemon [--dev]` | Run the daemon in the foreground |
| `pifi list` / `pifi status` | App table / daemon + RAM summary |
| `pifi start\|restart <app>` | Start / restart |
| `pifi stop <app> [--hard]` | Graceful stop (`--hard` = SIGKILL now) |
| `pifi send <app> '<json or text>'` | Send a request, print the response |
| `pifi logs <app>` | Last ~200 output lines |
| `pifi hash <app>` | Print the integrity hash for `pifi.json` |
| `pifi reload` | Re-scan `registered-apps/` |
| `pifi status [--json]` | Device ID, memory, **signaling state**, apps |
| `pifi identity [--json]` | Device ID + public key (never the private key) |
| `pifi pair [--ttl N] [--frontend URL] [--json] [--no-qr] [--cancel]` | One-time pairing code as a QR + link |
| `pifi devices list [--json]` | Paired phones (connected now? last seen) |
| `pifi devices revoke <id-prefix or label>` | Unpair a phone; its live session closes immediately |

### Identity and pairing

On first start the daemon creates `keys/identity.key` + `identity.pub` in
`PIFI_HOME`. The device ID is `base32(sha256(SPKI public key))`, 52 characters.

```bash
pifi identity
pifi pair --frontend https://your-shell-site.example   # or set PIFI_FRONTEND_URL
```

`pifi pair` prints a QR code for `<frontend>/pair#id=<deviceId>&s=<secret>`.
The secret is one-time, lives only in daemon memory, and expires (default 10 min,
`PIFI_PAIR_TTL_SEC`, max 3600). Anyone who sees the QR before it expires can pair,
so `clear` the terminal afterwards. The command prints "Open this on https://…":
make sure that is the host you expect.

### Signaling (Phase 2)

```bash
PORT=8080 npm run signal-server                                    # terminal 1: signaling server
PIFI_DEV=1 PIFI_SIGNAL_URL=ws://localhost:8080/ws pifi daemon       # terminal 2: daemon dials out
pifi status                                                         # signaling  online since ...
DEV_ID=$(pifi identity --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).deviceId')
npm run -s signal-testclient -- status $DEV_ID --url ws://localhost:8080/ws    # online
npm run -s signal-testclient -- echo $DEV_ID --url ws://localhost:8080/ws --data hello   # "hello"
```

Without `PIFI_SIGNAL_URL` the daemon behaves exactly as in Phase 1. The `echo`
reply only exists in dev mode. Details: [docs/signaling.md](docs/signaling.md).

The control API (`127.0.0.1:7778`, `Authorization: Bearer <contents of
admin.token>`) offers the same operations over HTTP.

### Configuration

| Setting | Default | Env |
|---|---|---|
| Data dir | `./pifi-data` (dev) / `/var/lib/pifi` | `PIFI_HOME` |
| App socket | `127.0.0.1:7777` | `PIFI_APP_PORT` |
| Control API | `127.0.0.1:7778` | `PIFI_CONTROL_PORT` |
| RAM safety margin | 100 MB | `PIFI_MEM_MARGIN_MB` |
| Log level | `info` | `PIFI_LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`) |
| Dev mode | off | `PIFI_DEV=1` or `--dev` |
| Signaling server | unset (disabled) | `PIFI_SIGNAL_URL` (`ws://` / `wss://`) |
| Signaling ping / backoff | 25 s / 1 s → 30 s | `PIFI_SIGNAL_PING_MS`, `PIFI_SIGNAL_BACKOFF_MIN_MS`, `PIFI_SIGNAL_BACKOFF_MAX_MS` |
| Pairing code lifetime | 600 s | `PIFI_PAIR_TTL_SEC` (max 3600) |
| Pair link base (CLI) | `https://macc-learn.github.io/PiFi_Runtime` | `PIFI_FRONTEND_URL` |
| STUN/TURN for phone sessions | `["stun:stun.l.google.com:19302"]` | `PIFI_ICE_SERVERS` (JSON array) |
| Concurrent phone sessions | 5 | `PIFI_MAX_SESSIONS` |
| Paired phones | 10 | `PIFI_MAX_PAIRED_PHONES` |
| Name shown on phones | hostname | `PIFI_DEVICE_NAME` |
| Idle session timeout | 45 s | `PIFI_SESSION_IDLE_SEC` |

## Production mode (hashes enforced)

Outside dev mode every manifest needs a `hash`:

```bash
pifi hash echo        # prints sha256-...; paste it into registered-apps/echo/pifi.json as "hash"
```

## Writing an app

With the SDK (Node):

```js
import { createApp } from '@pifi/sdk';
const app = createApp();
app.onRequest(async (payload) => ({ echoed: payload }));
app.onShutdown(async () => { /* cleanup */ });
await app.start();
```

Any language works: the contract is the JSON protocol in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#writing-an-app-in-any-language).
An app's dependencies must be resolvable from its own folder. In dev, apps
under `./pifi-data` inside this repo find the repo's `node_modules`; on a Pi,
run `npm install` inside the app folder (e.g. `npm install /path/to/pifi/packages/sdk`).

## Running on a Raspberry Pi

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pifi
sudo install -d -o pifi -g pifi -m 700 /var/lib/pifi
# install Node 20+ (e.g. from NodeSource), clone this repo somewhere pifi can read, then as the pifi user:
npm ci && npm run build
PIFI_HOME=/var/lib/pifi node packages/runtime/dist/src/cli.js daemon
```

Never run PiFi as root: apps inherit its privileges. For running it as a
service, see [docs/deploy-pi-systemd.md](docs/deploy-pi-systemd.md).

## Repository layout

```
packages/protocol          message types, zod schemas, shared crypto (deviceId, P-256)
packages/sdk               @pifi/sdk, helper for app authors
packages/runtime           the daemon, CLI and tests
packages/server            the signaling server (+ Dockerfile)
packages/signal-testclient fake phone CLI (runs the shell core in Node) + end-to-end tests
packages/shell             the phone web app (Vite + Preact), GitHub Pages workflow in .github/
packages/client            @pifi/client, for app pages inside the shell
examples/echo-app   happy-path demo
examples/test-fixtures/   deliberately misbehaving apps used by the tests
docs/               ARCHITECTURE.md, MANIFEST.md
```

## License

MIT, see [LICENSE](LICENSE).
