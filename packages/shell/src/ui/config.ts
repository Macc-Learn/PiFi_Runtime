/** Build-time configuration only (Phase 3 §9.5). Never read from the URL or the QR. */
export const SIGNAL_URL: string = import.meta.env.VITE_SIGNAL_URL || 'ws://localhost:8080/ws';

export const ICE_SERVERS: string[] = (() => {
  try {
    const v = JSON.parse(import.meta.env.VITE_ICE_SERVERS || '["stun:stun.l.google.com:19302"]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
})();
