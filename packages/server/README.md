# @pifi/server: signaling server

Presence + opaque relay between phones and Pis. No secrets, no files, no accounts,
no database, and no ability to start or stop anything on a Pi.

```bash
npm run build                       # from the repo root
PORT=8080 node packages/server/dist/src/index.js
curl localhost:8080/healthz         # ok
```

- WebSocket endpoint: `/ws`. `GET /healthz` → 200 `ok`; everything else → 404.
- Env: `PORT` (8080), `HOST` (0.0.0.0), `MAX_PHONES_PER_IP` (20), `LOG_LEVEL` (info), `TRUST_PROXY` (off).
- Docker: build from the **repo root**: `docker build -f packages/server/Dockerfile .`

| File | Job |
|---|---|
| `src/index.ts` | entry: config, start, graceful SIGTERM (close 4100, drain 8 s, exit 0) |
| `src/server.ts` | assembles HTTP + WebSocket + presence + limits; `createSignalingServer()` for tests |
| `src/wsHandler.ts` | per-connection roles, Pi challenge/response, relay routing |
| `src/http.ts` | `/healthz`, 404s, client IP (`X-Forwarded-For` last entry with `TRUST_PROXY`) |
| `src/presence/` | `PresenceStore` interface + `InMemoryPresenceStore` |
| `src/rateLimit.ts` | token buckets and registration-failure blocking |
| `src/logger.ts` | JSON logs; `shortId()` / `maskIp()` keep logs free of full IDs and IPs |

Protocol, handshake and close codes: [docs/signaling.md](../../docs/signaling.md).
Deploying: [docs/deploy-cloud-run.md](../../docs/deploy-cloud-run.md).
