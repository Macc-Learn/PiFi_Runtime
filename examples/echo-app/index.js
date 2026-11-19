// The happy-path demo app. It uses @pifi/sdk, so the whole protocol is hidden.
import { createApp } from '@pifi/sdk';

const app = createApp(); // reads PIFI_URL, PIFI_APP_NAME, PIFI_APP_TOKEN from the environment

// Whatever we return becomes the response payload; throwing sends an error response.
app.onRequest(async (payload) => {
  console.log('echo: got request', JSON.stringify(payload));
  return { echoed: payload, at: Date.now() };
});

// Called when PiFi asks us to stop. After it resolves the SDK exits with code 0.
app.onShutdown(async () => {
  console.log('echo: shutting down cleanly');
});

await app.start(); // connect -> hello -> welcome -> ready
console.log('echo: ready');
