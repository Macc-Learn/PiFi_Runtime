# Writing an app front-end

Every PiFi app is treated as third-party code, including the ones in this repo.
An app has two halves:

- **Pi side**: a process PiFi starts, using `@pifi/sdk` (or the raw protocol).
- **Web side** (optional): a static page at its own URL, which the shell opens
  inside a **sandboxed frame** and connects to the Pi side through `@pifi/client`.

The web page never sees keys, never makes its own WebRTC connection, and can only
talk to *its own* app.

## 1. Declare the front-end in `pifi.json`

```json
{
  "name": "echo",
  "displayName": "Echo",
  "frontend": "https://you.github.io/echo-frontend/",
  "...": "..."
}
```

`frontend` must be `https:` (`http://localhost` / `http://127.0.0.1` only with
`PIFI_DEV=1`). The dashboard shows "Open" for apps with a front-end, and
"No front-end" otherwise.

The first time a phone opens it (per Pi, per app, per **origin**), the shell asks:
*"Open `<origin>` inside PiFi? This page can send requests to the `<app>` app on
your Pi. It cannot see your keys or your other apps."* If the Pi later reports a
different origin, the shell asks again.

## 2. Use `@pifi/client` in the page

```js
import { connect } from '@pifi/client';

let pifi;
try {
  pifi = await connect();              // the shell hands this frame a MessagePort
} catch (err) {
  // err.code === 'NOT_IN_SHELL': opened directly, outside PiFi
  document.body.textContent = 'Open this app from your PiFi dashboard.';
}

const reply = await pifi.request('echo', { text: 'hi' }, { timeoutMs: 30000 });
const off = pifi.on('count', (data) => console.log('event', data));
pifi.onStatus((s) => console.log(s));  // 'online' | 'reconnecting'

const up = await pifi.openStream('upload-echo', { size: bytes.length });
const back = [];
const reading = (async () => { for await (const chunk of up) back.push(chunk); })();
await up.write(bytes);                 // chunked to 16 KiB, waits on backpressure
await up.end();                        // done sending; resolves when the app finished too
await reading;
```

Errors are `PifiError`s with a `code`: `DISCONNECTED` (Pi connection down;
nothing is retried for you), `TIMEOUT`, `RATE_LIMITED`, `TOO_LARGE`,
`APP_NOT_RUNNING`, or the code your app's Pi side threw.

The package is a plain ES module with no dependencies (`packages/client/dist/index.js`).

## 3. The Pi side (`@pifi/sdk`)

```js
import { createApp } from '@pifi/sdk';
const app = createApp();
app.onRequest(async ({ op, payload }) => {
  if (op === 'echo') return payload;
  throw Object.assign(new Error('unknown op'), { code: 'NOT_FOUND' });
});
app.onStream('upload-echo', async (stream, meta) => {
  for await (const chunk of stream) await stream.write(chunk);
  stream.end();
});
setInterval(() => app.emit('count', { n: Date.now() }), 1000); // to subscribed pages
await app.start();
```

## What a frame can and cannot do

| can | cannot |
|---|---|
| send requests to its own app | name another app (the shell sets `app`) |
| subscribe to its own app's events | send control ops (start/stop apps, list or revoke phones) |
| open streams to its own app | read the shell's storage or keys (opaque origin) |
| run scripts, forms, downloads | navigate the top page, open popups, keep its port after navigating |

The frame is created with
`sandbox="allow-scripts allow-forms allow-downloads"`, `referrerpolicy="no-referrer"`
and `allow=""`. Never `allow-same-origin`, `allow-top-navigation` or `allow-popups`.
The shell enforces per-frame limits: 50 requests/s (burst 100), 64 KiB per
message, 16 KiB per stream chunk, 16 un-acknowledged chunks per stream.

## Serving the page

Inside the sandbox the page has an **opaque origin** (`null`). So:

- Prefer a single classic `<script src>` bundle. `type="module"` scripts are
  fetched with CORS and need `Access-Control-Allow-Origin` from your host
  (GitHub Pages sends `*`; many local dev servers don't). The echo example
  bundles to one IIFE file: see `examples/echo-app/frontend/build.mjs`.
- `localStorage`, `indexedDB` and cookies are unavailable. Keep state on the Pi.

## The echo example

`examples/echo-app/frontend/` exercises everything: a request (`echo`), events
(`count` / `stop`) and a stream (`upload-echo`, which checks every byte comes
back and reports throughput). Build it with `node examples/echo-app/frontend/build.mjs <outDir>`;
the Pages workflow publishes it at `<shell>/examples/echo/`.
