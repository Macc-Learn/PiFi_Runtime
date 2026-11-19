# Security

> **PiFi is experimental and has not been security-audited.** Do not expose it
> to the internet or rely on it to protect sensitive data yet.

## Reporting a vulnerability

Please report privately, not in a public issue: use GitHub's **"Report a
vulnerability"** button under this repository's *Security* tab (private
advisories). Include what you found, how to reproduce it, and the version.

## Phase 1 threat model

Phase 1 is the local core only: there is no network connection to the outside
world, no WebRTC and no pairing yet.

**What Phase 1 protects against**

| Threat | Defence |
|---|---|
| Other machines reaching PiFi's ports | Both servers bind `127.0.0.1` only |
| A web page in a local browser talking to the app socket or control API | Any request with an `Origin` header is refused (4004 / HTTP 403); control API also checks the `Host` header (DNS rebinding) |
| A local process impersonating an app | Per-launch 256-bit random token, compared in constant time, dies with the process; one connection per app |
| Unauthorised use of the control API | Bearer admin token in `admin.token` (mode `0600`), compared in constant time |
| Command injection via manifests | `spawn` with `shell: false` and an args array; no string is ever passed to a shell |
| Path traversal via app names | Names must match `^[a-z0-9][a-z0-9-]{0,31}$` and equal their folder name |
| Secrets leaking to apps | Apps get a minimal environment (`PATH`, `NODE_ENV`, `PIFI_*`, manifest `env`), not PiFi's own |
| Tampered app files | SHA-256 of the app folder verified before every launch (outside `--dev`) |
| Oversized / malformed frames | 1 MiB `maxPayload`, strict schema validation, 3 s `hello` deadline |

**What Phase 1 does NOT protect against**

- Anyone who can read `admin.token` or run as the same OS user. Run PiFi as a
  dedicated unprivileged user and keep `PIFI_HOME` private to it.
- A malicious or buggy **app**. Apps are separate processes with the same OS
  privileges as PiFi's user; there is no sandbox, and memory limits are
  checked at start but **not enforced** (cgroups are a later phase).
- Tampering with `node_modules` inside an app folder (excluded from the hash).
- A tiny race between choosing a free port and the app binding it.
- Anything about the future network layers (signaling, WebRTC, pairing).
  Those will get their own threat model when built.
