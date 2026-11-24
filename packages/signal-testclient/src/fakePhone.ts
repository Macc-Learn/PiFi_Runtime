/**
 * A full fake phone for Node (Phase 3 §13): it runs the SHELL'S OWN core code
 * (pairing, session handshake, wire client, connection manager) with Node's
 * WebCrypto, node-datachannel's RTCPeerConnection polyfill and a WebSocket.
 * So the end-to-end test exercises exactly what the phone browser runs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import WsWebSocket from 'ws';
import { ConnectionManager, openSession, pairWithPi, parsePairFragment, WireClient, type PiRecord, type ShellEnv } from '@pifi/shell/core';

export async function nodeEnv(): Promise<ShellEnv> {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill');
  return {
    crypto: globalThis.crypto,
    // Node 22 has a global WebSocket; on Node 20 fall back to `ws` (same browser-style API).
    WebSocket: (globalThis.WebSocket ?? WsWebSocket) as unknown as ShellEnv['WebSocket'],
    RTCPeerConnection: RTCPeerConnection as unknown as ShellEnv['RTCPeerConnection'],
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

/** Stop libdatachannel's threads so Node can exit. */
export async function shutdownWebRtc(): Promise<void> {
  const ndc = (await import('node-datachannel')).default;
  ndc.cleanup();
}

/** Pair from a `pifi pair` link (only the fragment matters: #id=...&s=...). */
export async function pairFromLink(link: string, signalUrl: string, label = 'Fake phone', opts: { extractable?: boolean } = {}): Promise<PiRecord> {
  const target = parsePairFragment(new URL(link).hash);
  if (!target) throw new Error('not a valid pair link (expected ...#id=<deviceId>&s=<secret>)');
  const env = await nodeEnv();
  const keyPair = opts.extractable
    ? ((await env.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair)
    : undefined;
  return pairWithPi({ ...target, label, signalUrl, env, keyPair, retryMs: 1000, maxWaitMs: 10_000 });
}

/** One direct session; returns a wire client over the real data channel. */
export async function connectDirect(pi: PiRecord, signalUrl: string, iceServers: string[] = []): Promise<{ client: WireClient; close: () => void }> {
  const env = await nodeEnv();
  const { pc, channel } = await openSession({ pi, signalUrl, iceServers, env });
  const client = new WireClient(channel);
  return { client, close: () => { client.close(); pc.close(); } };
}

export async function connectionManager(pi: PiRecord, signalUrl: string, iceServers: string[] = []): Promise<ConnectionManager> {
  return new ConnectionManager({ pi, signalUrl, iceServers, env: await nodeEnv(), minBackoffMs: 200, maxBackoffMs: 2000 });
}

// ---- state file for the CLI (a test tool: the key IS exported here, unlike in a browser) ----

interface SavedPi { deviceId: string; piSpki: string; label: string; phoneId: string; privateJwk: JsonWebKey; publicJwk: JsonWebKey; createdAt: number }

export async function saveState(file: string, rec: PiRecord): Promise<void> {
  const privateJwk = await crypto.subtle.exportKey('jwk', rec.keyPair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', rec.keyPair.publicKey);
  const saved: SavedPi = { deviceId: rec.deviceId, piSpki: rec.piSpki, label: rec.label, phoneId: rec.phoneId, privateJwk, publicJwk, createdAt: rec.createdAt };
  await writeFile(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

export async function loadState(file: string): Promise<PiRecord> {
  const s = JSON.parse(await readFile(file, 'utf8')) as SavedPi;
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  const privateKey = await crypto.subtle.importKey('jwk', s.privateJwk, alg, false, ['sign']);
  const publicKey = await crypto.subtle.importKey('jwk', s.publicJwk, alg, true, ['verify']);
  return { deviceId: s.deviceId, piSpki: s.piSpki, label: s.label, phoneId: s.phoneId, keyPair: { privateKey, publicKey }, createdAt: s.createdAt, lastUsedAt: Date.now() };
}
