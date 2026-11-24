/**
 * What gets signed or MACed (Phase 3 §4.1). Pure functions: the Pi (Node) and
 * the shell (WebCrypto) build byte-identical messages from these.
 */
import { concatBytes, utf8 } from './encoding.js';

/** HMAC input for pairing (unchanged since the Phase 1 revision): plain concatenation. */
export const PAIR_PROOF_CONTEXT = 'pifi-pair-v1';
export const PAIR_ACCEPT_CONTEXT = 'pifi-pair-accept-v1';
export const SESSION_PHONE_CONTEXT = 'pifi-session-phone-v1';
export const SESSION_PI_CONTEXT = 'pifi-session-pi-v1';

/**
 * utf8(context), then for each part: 4-byte big-endian length, then the bytes.
 * The length prefixes make it impossible to shift bytes from one part into the next.
 */
export function signedMessage(context: string, ...parts: Uint8Array[]): Uint8Array {
  const pieces: Uint8Array[] = [utf8(context)];
  for (const part of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, part.length, false);
    pieces.push(len, part);
  }
  return concatBytes(...pieces);
}

/**
 * HMAC-SHA256 input for the pairing proof:
 *   "pifi-pair-v1" || utf8(deviceId) || phoneSpki
 * (Key = the pairing secret's 16 raw bytes, i.e. base64url-decoded `s` from the QR.)
 */
export function pairProofMessage(deviceId: string, phoneSpki: Uint8Array): Uint8Array {
  return concatBytes(utf8(PAIR_PROOF_CONTEXT), utf8(deviceId), phoneSpki);
}

const FINGERPRINT_LINE = /^a=fingerprint:(\S+)\s+(\S+)\s*$/i;
const SHA256_HEX = /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/i;

/**
 * The DTLS certificate fingerprint from an SDP, as 32 raw bytes.
 * Requires at least one `a=fingerprint:` line, every one `sha-256`, all identical.
 * Anything else returns undefined, and the caller must reject the SDP.
 */
export function fingerprintBytes(sdp: string): Uint8Array | undefined {
  let value: string | undefined;
  let count = 0;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^a=fingerprint:/i.test(line)) continue;
    const m = FINGERPRINT_LINE.exec(line);
    if (!m) return undefined;
    const [, alg, hex] = m as unknown as [string, string, string];
    if (alg.toLowerCase() !== 'sha-256' || !SHA256_HEX.test(hex)) return undefined;
    const normal = hex.toLowerCase();
    if (value !== undefined && value !== normal) return undefined;
    value = normal;
    count++;
  }
  if (count === 0 || value === undefined) return undefined;
  return Uint8Array.from(value.split(':').map((h) => parseInt(h, 16)));
}
