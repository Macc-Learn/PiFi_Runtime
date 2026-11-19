# App manifest (`pifi.json`)

Every app lives in `${PIFI_HOME}/registered-apps/<name>/` and has a `pifi.json`
next to its code. PiFi derives the app's directory from where it found the
manifest; the directory is **not** a manifest field.

```json
{
  "name": "echo",
  "version": "1.0.0",
  "description": "Echoes requests back",
  "command": "node",
  "args": ["index.js"],
  "memoryMB": 60,
  "needsPort": false,
  "autostart": false,
  "restart": { "policy": "on-crash", "maxRestarts": 3, "windowSec": 60 },
  "startTimeoutMs": 15000,
  "env": {},
  "frontend": "https://example.com/echo",
  "hash": "sha256-…"
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | | `^[a-z0-9][a-z0-9-]{0,31}$` **and** equal to the folder name. |
| `version` | yes | | Semver, e.g. `1.0.0`. |
| `description` | no | | Up to 500 characters. |
| `command` | yes | | Executable (`node`, `python3`, …). Run without a shell. |
| `args` | no | `[]` | String array. `{{PORT}}` is replaced if `needsPort` is true. |
| `memoryMB` | yes | | Estimated RAM need. Start is refused unless `MemAvailable ≥ memoryMB + margin` (margin default 100 MB). |
| `needsPort` | no | `false` | PiFi picks a free loopback port, passes it as env `PORT` and in `{{PORT}}`. |
| `autostart` | no | `false` | Start when the daemon boots (unless your saved desired state says otherwise, see below). |
| `restart.policy` | no | `on-crash` | `never` or `on-crash`. |
| `restart.maxRestarts` | no | `3` | Max automatic restarts within the window. |
| `restart.windowSec` | no | `60` | Length of the window. Backoff is 1 s, 2 s, 4 s… |
| `startTimeoutMs` | no | `15000` | Time allowed to reach `ready`. |
| `env` | no | `{}` | Extra environment variables (string → string). `PIFI_*` can't be overridden. |
| `frontend` | no | | Informational for now (future: allowed front-end origin). |
| `hash` | outside `--dev` | | See below. |

Unknown fields are **rejected**, so a typo like `autostrat` is an error rather
than being silently ignored. A bad manifest only disables that one app; the
rest still load (the error is logged and shown by `pifi reload`).

## Environment the app receives

Only: `PATH`, `NODE_ENV`, `PIFI_URL`, `PIFI_APP_NAME`, `PIFI_APP_TOKEN`, `PORT`
(if `needsPort`), and whatever is in the manifest's `env`.

## Integrity hash

`pifi hash <app>` prints the value to paste into `hash`.

Algorithm: take every file under the app folder, **excluding** `pifi.json` and
any `node_modules` directory; sort by relative POSIX path; feed
`path + "\0" + file bytes` into SHA-256 for each; format as `sha256-<hex>`.
Symbolic links are hashed by their target text and never followed.

It is verified before **every** launch, including automatic restarts. A
mismatch (or a missing hash) puts the app in `failed` and nothing is spawned.
`--dev` / `PIFI_DEV=1` skips the check with a loud warning.

**Phase 1 limitation:** `node_modules` is not covered, so changes to
installed dependencies are not detected.

## Desired state and `autostart`

`state.json` remembers what you explicitly asked for (`pifi start` /
`pifi stop`). On boot: an app with a saved desired state follows it; an app
with none follows its manifest's `autostart`. So if you stop an `autostart`
app on purpose, it stays stopped after a reboot.
