/**
 * Byte encodings that work the same in Node and in browsers (no Buffer, no node:*).
 * The shell imports these through `@pifi/protocol/browser`.
 */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0; // holds the not-yet-emitted bits
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1; // drop emitted bits so the number never grows
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX = new Map([...B64URL].map((c, i) => [c, i]));

/** base64url without padding. */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let j = 0; j < chars; j++) out += B64URL[(n >>> (18 - 6 * j)) & 63];
  }
  return out;
}

/** Strict base64url decode (no padding, no stray bits). Returns undefined for anything else. */
export function b64urlDecode(text: string): Uint8Array | undefined {
  if (text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    const chunk = text.slice(i, i + 4);
    for (let j = 0; j < 4; j++) {
      const v = j < chunk.length ? B64URL_INDEX.get(chunk[j] as string) : 0;
      if (v === undefined) return undefined;
      n = (n << 6) | v;
    }
    const bytes = chunk.length - 1; // 4 chars -> 3 bytes, 3 -> 2, 2 -> 1
    for (let j = 0; j < bytes; j++) out[o++] = (n >>> (16 - 8 * j)) & 255;
  }
  // Round trip rejects non-canonical input (e.g. impossible trailing bits).
  return b64urlEncode(out) === text ? out : undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Strict UTF-8 decode; undefined for invalid bytes. */
export function fromUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
