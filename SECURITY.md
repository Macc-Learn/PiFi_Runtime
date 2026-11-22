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

## Identity and pairing (Phase 1 revision)

- The Pi's private key (`keys/identity.key`, mode `0600`, folder `0700`) is never
  printed, logged, returned by an API or put in an error message. It is held in a
  closure, not in any property. On Windows these permissions can't be enforced.
- **What the pairing QR reveals:** the device ID (public) and a **live one-time
  secret**. Anyone who sees the QR or link before it expires (default 10 min) can
  pair once Phase 3 exists. Clear the terminal afterwards; revoke with
  `pifi pair --cancel`.
- **Fragment, not query:** the secret is in the URL `#fragment`. Browsers never
  send fragments in HTTP requests, so neither the static host serving `/pair` nor
  any proxy or log ever receives it.
- **Why the secret is kept in plaintext, in memory only:** in Phase 3 the phone
  proves it knows the secret with `HMAC-SHA256(key = secret, …)`. The secret is
  never sent over the connection, because a malicious signaling server could read
  it. To check that HMAC, the Pi must hold the key itself, so a hash isn't enough.
  It is never written to disk or logged, and only the single `POST /pair` response
  contains it.
- **Phase 3 must rate-limit pairing attempts**, e.g. burn the code after 5 failed
  proofs, and compare proofs with `timingSafeEqual`.

## Signaling (Phase 2)

The signaling server is treated as **untrusted**:

- It holds no secrets, keys, files, accounts or database, and has no message
  that could start or stop an app. A compromised server can see who is online and
  when, and can drop, delay or forge *relayed* messages. Phase 3 must therefore
  authenticate phone↔Pi end to end and bind it to the WebRTC DTLS fingerprints.
- A Pi becomes online only by signing a fresh, single-use, per-connection nonce
  with the key whose hash *is* its deviceId, so nobody can impersonate a Pi
  without its private key, or replay an old handshake.
- In Phase 2 the Pi ignores every relayed message except the dev-only echo.
- Server logs never contain payloads, signatures, nonces, keys or full IPs;
  deviceIds are truncated to 8 characters. IPs are kept only in in-memory
  rate-limit counters and swept when idle.
- Rate limits: connections, messages and failed registrations per IP; phone
  connections per IP. They slow abuse but don't stop a distributed attacker.
- Not covered yet: TURN, DoS beyond these limits, and multi-instance presence.
