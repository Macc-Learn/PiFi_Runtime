# Deploying the signaling server to Cloud Run

> Flag names and defaults on Cloud Run change over time. Check every command
> below against the current Cloud Run documentation before relying on it.

## 1. Build the image from the repository ROOT

The server imports the shared `packages/protocol` workspace, so the Docker
**build context must be the repo root**, not `packages/server/`. Building from
inside `packages/server/` fails because Docker can't see the shared package.

```bash
# from the repository root:
docker build -f packages/server/Dockerfile -t pifi-signal .
docker run --rm -p 8080:8080 pifi-signal      # try it: curl localhost:8080/healthz -> ok
```

The root `.dockerignore` keeps `node_modules`, `.git`, build output, `keys/`,
`*.key`, `*.token` and `pifi-data/` out of the build context. **A Pi's identity
keys must never end up in an image.** Don't build on a Pi that has a
`PIFI_HOME` inside the repo without that file in place.

The image (`packages/server/Dockerfile`): Node 22 slim, two stages (compile, then
`npm ci --omit=dev` with only the server's production dependencies: `ws`, `zod`
and the shared protocol), runs as the unprivileged `node` user, and starts with
`node dist/src/index.js` from `packages/server`.

## 2. Push and deploy

```bash
REGION=europe-west1
IMAGE=$REGION-docker.pkg.dev/YOUR_PROJECT/pifi/signal:v1

docker build -f packages/server/Dockerfile -t $IMAGE .
docker push $IMAGE

gcloud run deploy pifi-signal \
  --image=$IMAGE \
  --region=$REGION \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=1 \
  --timeout=3600 \
  --concurrency=1000 \
  --port=8080 \
  --set-env-vars=TRUST_PROXY=1
```

Point Pis at `wss://<your-service-url>/ws`.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Cloud Run injects this |
| `HOST` | 0.0.0.0 | listen address (Cloud Run needs 0.0.0.0) |
| `TRUST_PROXY` | off | `1`: take the client IP from the **last** `X-Forwarded-For` entry (the one the platform appended). Verify Cloud Run's current header format. |
| `MAX_PHONES_PER_IP` | 20 | |
| `LOG_LEVEL` | info | JSON lines; Cloud Run maps `severity` to log levels |
| `FIRST_MESSAGE_TIMEOUT_MS` | 10000 | unidentified sockets are closed after this |
| `PHONE_IDLE_TIMEOUT_MS` | 120000 | idle phone sockets are closed |
| `MAX_CONNECTIONS` | 800 | total sockets (503 above it) |
| `MAX_PHONE_CONNECTIONS` | 600 | the rest is reserved for Pis |
| `MAX_PIS_PER_IP` | 5 | |

## 3. Why these settings

**`--max-instances=1`.** Presence (who is online) lives in the server's memory.
With two instances a Pi would be registered on one and a phone might land on
the other, which would say "offline". One instance keeps the picture whole.
A single small instance handles thousands of mostly idle sockets.

**`--min-instances=1` vs `0`.** With 1, the instance is always warm and Pis stay
connected; you pay for it around the clock. With 0, Cloud Run may scale to zero
when idle. But connected Pis count as traffic, so in practice it stays up as long
as any Pi is online, and the first connection after a scale-down waits for a cold
start. Use 1 if you want predictable reconnects, 0 to save money on a hobby setup.

**`--timeout=3600`.** A WebSocket is one long HTTP request, and Cloud Run cuts any
request at the timeout (60 minutes max). Every connection is therefore dropped at
least once an hour. That is expected: the Pi reconnects with backoff and is
online again within seconds. Phones will need to do the same.

**`--concurrency=1000`.** Each open socket counts as one concurrent request.

**Deploys and restarts wipe presence.** On SIGTERM the server closes every socket
with code **4100** ("reconnect promptly"), waits up to 8 s, and exits. Pis reconnect
after a random 0–3 s, so presence rebuilds by itself within a few seconds.

## 4. Scaling later: the PresenceStore seam

All presence access goes through the async `PresenceStore` interface
(`packages/server/src/presence/`). To run more than one instance you'd add a
Redis-backed store. Redis can't hold a live socket, so it would store
`deviceId → instanceId` with a TTL refreshed by keepalives, and instances would
forward messages to each other over Redis pub/sub. `getConnection()` would then
likely become `deliver(deviceId, message)`. The contract tests in
`packages/server/test/presenceContract.ts` are written against the interface so
a new store can reuse them.
