/**
 * Everything the shell core needs from its surroundings, injected so the same
 * code runs in a browser, in Vitest, and in Node (the end-to-end fake phone,
 * which plugs in node-datachannel's RTCPeerConnection polyfill).
 */
export interface ShellEnv {
  crypto: Crypto;
  WebSocket: new (url: string) => WebSocket;
  RTCPeerConnection: new (config?: RTCConfiguration) => RTCPeerConnection;
  now(): number;
  random(): number;
}

export function browserEnv(): ShellEnv {
  return {
    crypto: globalThis.crypto,
    WebSocket: globalThis.WebSocket,
    RTCPeerConnection: globalThis.RTCPeerConnection,
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
