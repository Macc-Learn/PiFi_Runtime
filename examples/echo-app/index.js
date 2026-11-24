// The demo app. It uses @pifi/sdk, so the whole protocol is hidden.
//
// Requests from a phone arrive as { op, payload }:
//   echo         -> returns the payload
//   count        -> emits a "count" event every second until "stop"
//   stop         -> stops counting
// Streams:
//   upload-echo  -> sends every byte it receives straight back
// Anything else (e.g. `pifi send echo '{"hi":1}'`) gets the Phase 1 reply { echoed, at }.
import { createApp } from '@pifi/sdk';

const app = createApp(); // reads PIFI_URL, PIFI_APP_NAME, PIFI_APP_TOKEN from the environment
let counter;

app.onRequest(async (req) => {
  console.log('echo: got request', JSON.stringify(req));
  if (req && typeof req === 'object' && typeof req.op === 'string') {
    switch (req.op) {
      case 'echo':
        return req.payload;
      case 'count': {
        clearInterval(counter);
        const every = Math.max(50, Number(req.payload?.intervalMs ?? 1000));
        let n = 0;
        counter = setInterval(() => app.emit('count', { n: ++n }), every);
        return { counting: true, intervalMs: every };
      }
      case 'stop':
        clearInterval(counter);
        return { counting: false };
      default:
        throw Object.assign(new Error(`unknown op "${req.op}"`), { code: 'NOT_FOUND' });
    }
  }
  return { echoed: req, at: Date.now() };
});

app.onStream('upload-echo', async (stream) => {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    await stream.write(chunk); // waits if the phone is slow (backpressure)
  }
  stream.end();
  console.log(`echo: stream echoed ${bytes} bytes`);
});

app.onShutdown(async () => {
  clearInterval(counter);
  console.log('echo: shutting down cleanly');
});

await app.start(); // connect -> hello -> welcome -> ready
console.log('echo: ready');
