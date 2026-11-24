/**
 * Shell build. Two HTML entry points: index.html (dashboard) and pair/index.html
 * (the QR link target `<frontend>/pair#id=...&s=...`), both booting one bundle.
 *
 * Build-time settings (never taken from the page URL or the QR, so a crafted link
 * can't point the shell at an attacker's signaling server):
 *   VITE_SIGNAL_URL   wss://... signaling endpoint
 *   VITE_ICE_SERVERS  JSON array of STUN/TURN URLs
 *   VITE_BASE         base path, e.g. /PiFi_Runtime/ for a GitHub project site
 */
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const signalUrl = env.VITE_SIGNAL_URL || 'ws://localhost:8080/ws';
  if (!/^wss?:\/\//.test(signalUrl)) throw new Error('VITE_SIGNAL_URL must be a ws:// or wss:// URL');
  const signalOrigin = new URL(signalUrl).origin;
  return {
    base: env.VITE_BASE || '/',
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    build: {
      target: 'es2022',
      rollupOptions: { input: { main: 'index.html', pair: 'pair/index.html' } },
    },
    plugins: [
      {
        // GitHub Pages can't send HTTP headers, so the CSP lives in a <meta> tag; fill in the signaling origin.
        name: 'pifi-csp',
        transformIndexHtml: (html: string) => html.replaceAll('%PIFI_SIGNAL_ORIGIN%', signalOrigin),
      },
    ],
    test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
  };
});
