// Browser smoke test: the REAL built shell in headless Chromium, against a real
// signaling server and a real PiFi daemon (node-datachannel WebRTC) on this machine.
//
//   npm run build && node scripts/browser-smoke.mjs [screenshotDir]
//
// Needs Playwright with Chromium (not a project dependency). Steps:
//   pair from a QR-style link -> dashboard "Direct connection" -> start echo ->
//   open it (consent) -> use the echo page inside the sandboxed frame ->
//   hostile checks from inside the frame.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = path.resolve(process.argv[2] ?? path.join(root, '.tmp-tests', 'screens'));
const { Daemon, loadConfig } = await import(path.join(root, 'packages/runtime/dist/src/index.js'));
const { createSignalingServer, loadServerConfig, createLogger } = await import(path.join(root, 'packages/server/dist/src/server.js'));

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve(dir, port) {
  const server = http.createServer(async (req, res) => {
    let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try { if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html'); res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(p)); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
const step = (m) => console.log(`- ${m}`);

const [sigPort, shellPort, echoPort] = await Promise.all([freePort(), freePort(), freePort()]);
const work = await mkdtemp(path.join(root, '.tmp-tests', 'browser-'));
await mkdir(shotDir, { recursive: true });
const signal = createSignalingServer(loadServerConfig({}, { host: '127.0.0.1', port: sigPort }), { log: createLogger('silent') });
let daemon, browser;
const servers = [];
try {
  await signal.listen();

  // The shell, built for this local signaling server (build-time config, as in production).
  process.env.VITE_SIGNAL_URL = `ws://127.0.0.1:${sigPort}/ws`;
  process.env.VITE_ICE_SERVERS = '[]';
  process.env.VITE_BASE = '/';
  await build({ root: path.join(root, 'packages/shell'), logLevel: 'warn', build: { outDir: path.join(work, 'shell'), emptyOutDir: true } });
  execFileSync(process.execPath, [path.join(root, 'examples/echo-app/frontend/build.mjs'), path.join(work, 'echo')], { stdio: 'ignore' });
  servers.push(await serve(path.join(work, 'shell'), shellPort), await serve(path.join(work, 'echo'), echoPort));
  step(`shell on http://127.0.0.1:${shellPort}, echo page on http://127.0.0.1:${echoPort}, signaling on :${sigPort}`);

  // The daemon, with the echo app pointing at the locally served page (http://127.0.0.1 is allowed in dev).
  const home = path.join(work, 'home');
  await cp(path.join(root, 'examples/echo-app'), path.join(home, 'registered-apps/echo'), { recursive: true, filter: (s) => !s.includes(`${path.sep}frontend`) });
  const manifestPath = path.join(home, 'registered-apps/echo/pifi.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, frontend: `http://127.0.0.1:${echoPort}/` }));
  daemon = new Daemon({ config: loadConfig({ PIFI_HOME: home }, { dev: true, appPort: 0, controlPort: 0, logLevel: 'warn', signalUrl: `ws://127.0.0.1:${sigPort}/ws`, iceServers: [] }) });
  await daemon.start();
  for (let i = 0; i < 100 && daemon.signalingState().state !== 'online'; i++) await new Promise((r) => setTimeout(r, 50));
  const code = daemon.pairing.create(300);
  const link = `http://127.0.0.1:${shellPort}/pair/#id=${daemon.identity.deviceId}&s=${code.secret}`;
  step(`daemon online as ${daemon.identity.deviceId.slice(0, 8)}…`);

  // Chromium hides host IPs behind mDNS names by default; libdatachannel can't resolve those on loopback.
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // 1. Pair
  await page.goto(link);
  if (new URL(page.url()).hash !== '') throw new Error('pairing secret still in the address bar');
  step('fragment removed from the address bar');
  await page.getByText(`127.0.0.1:${shellPort}`).first().waitFor();
  await page.screenshot({ path: path.join(shotDir, '1-pair.png') });
  await page.fill('#label', 'Smoke phone');
  await page.getByRole('button', { name: 'Pair' }).click();
  await page.waitForURL(/#\/pi\/[a-z2-7]{52}$/, { timeout: 30_000 });
  step('paired; on the dashboard');
  if (!daemon.paired.list().some((p) => p.label === 'Smoke phone')) throw new Error('Pi did not store the phone');

  // 2. Dashboard over a direct connection
  await page.getByText('Online · Direct connection').waitFor({ timeout: 30_000 });
  step('direct WebRTC connection is up');
  await page.getByText('(this phone)').waitFor();
  await page.getByRole('button', { name: 'Start' }).first().click();
  await page.getByRole('button', { name: 'Stop' }).first().waitFor({ timeout: 15_000 });
  step('echo started from the phone');
  await page.screenshot({ path: path.join(shotDir, '2-dashboard.png') });

  // 3. Open the app: consent, then the sandboxed frame
  await page.getByRole('link', { name: 'Open' }).first().click();
  await page.getByText(`http://127.0.0.1:${echoPort}`).waitFor();
  await page.screenshot({ path: path.join(shotDir, '3-consent.png') });
  await page.getByRole('button', { name: 'Open' }).click();
  const frameEl = page.locator('iframe.appframe');
  await frameEl.waitFor();
  const sandbox = await frameEl.getAttribute('sandbox');
  if (sandbox !== 'allow-scripts allow-forms allow-downloads') throw new Error(`unexpected sandbox: ${sandbox}`);
  const frame = page.frameLocator('iframe.appframe');
  await frame.getByText('Connected to your Pi.').waitFor({ timeout: 15_000 });
  await frame.locator('#echo').click();
  await frame.locator('#echo-out', { hasText: 'hello from the phone' }).waitFor({ timeout: 15_000 });
  step('request from the app page reached the echo app and came back');
  await frame.locator('#count').click();
  await frame.locator('#count-out', { hasText: /^[1-9]/ }).waitFor({ timeout: 10_000 });
  await frame.locator('#stop').click();
  step('events from the app reach the page');
  await frame.locator('#size').fill('1024');
  await frame.locator('#upload').click();
  await frame.locator('#upload-out', { hasText: 'OK:' }).waitFor({ timeout: 60_000 });
  step(`stream: ${await frame.locator('#upload-out').textContent()}`);
  await page.screenshot({ path: path.join(shotDir, '4-app.png') });

  // 4. Hostile checks, run INSIDE the frame
  const child = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${echoPort}`));
  const hostile = await child.evaluate(async () => {
    const out = {};
    try { localStorage.getItem('x'); out.storage = 'readable'; } catch { out.storage = 'blocked'; }
    try { window.parent.document.title; out.parentDom = 'readable'; } catch { out.parentDom = 'blocked'; }
    try { indexedDB.open('pifi'); out.idb = 'opened'; } catch { out.idb = 'blocked'; }
    out.origin = self.origin;
    return out;
  });
  if (hostile.storage !== 'blocked' || hostile.parentDom !== 'blocked' || hostile.origin !== 'null') throw new Error(`sandbox leak: ${JSON.stringify(hostile)}`);
  step(`frame is isolated: ${JSON.stringify(hostile)}`);
  await child.evaluate(() => { window.location.href = 'about:blank'; }).catch(() => undefined);
  await page.getByText(/tried to navigate away/).waitFor({ timeout: 10_000 });
  step('navigation inside the frame destroyed it (navigation guard)');

  if (consoleErrors.length) console.log('console errors (CSP or otherwise):\n  ' + consoleErrors.join('\n  '));
  console.log(`BROWSER SMOKE TEST PASSED. Screenshots in ${shotDir}`);
} catch (err) {
  console.error('BROWSER SMOKE TEST FAILED:', err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await daemon?.stop();
  await signal.shutdown();
  for (const s of servers) s.close();
  await rm(work, { recursive: true, force: true });
}
