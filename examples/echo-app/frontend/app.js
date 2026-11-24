// The echo app's page. It runs inside the PiFi shell's sandboxed frame and talks
// to the echo app on the Pi only through @pifi/client.
import { connect } from '@pifi/client';

const $ = (id) => document.getElementById(id);

function show(id, text) {
  $(id).textContent = text; // never innerHTML: data from the Pi is text, not markup
}

async function main() {
  let pifi;
  try {
    pifi = await connect();
  } catch (err) {
    show('status', err.message); // "Open this app from your PiFi dashboard."
    return;
  }
  pifi.onStatus((s) => show('status', s === 'online' ? 'Connected to your Pi.' : 'Reconnecting…'));

  $('echo').addEventListener('click', async () => {
    try {
      const reply = await pifi.request('echo', { text: $('text').value });
      show('echo-out', JSON.stringify(reply));
    } catch (err) {
      show('echo-out', `${err.code}: ${err.message}`);
    }
  });

  pifi.on('count', (data) => show('count-out', String(data?.n)));
  $('count').addEventListener('click', () => pifi.request('count', { intervalMs: 1000 }).catch((e) => show('count-out', e.code)));
  $('stop').addEventListener('click', () => pifi.request('stop').catch(() => undefined));

  $('upload').addEventListener('click', async () => {
    const size = Math.max(1, Math.min(102400, Number($('size').value) || 1)) * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65536)));
    show('upload-out', `uploading ${size} bytes…`);
    const started = performance.now();
    try {
      const stream = await pifi.openStream('upload-echo', { size });
      const received = [];
      const reading = (async () => { for await (const chunk of stream) received.push(chunk); })();
      await stream.write(data); // chunked to 16 KiB with backpressure inside the client
      await stream.end();
      await reading;
      const back = new Uint8Array(received.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of received) { back.set(c, o); o += c.length; }
      const same = back.length === data.length && back.every((b, i) => b === data[i]);
      const secs = (performance.now() - started) / 1000;
      show('upload-out', `${same ? 'OK' : 'MISMATCH'}: ${back.length} bytes back in ${secs.toFixed(2)} s (${((2 * size) / 1024 / secs).toFixed(0)} KiB/s both ways)`);
    } catch (err) {
      show('upload-out', `${err.code ?? 'ERROR'}: ${err.message}`);
    }
  });
}

main();
