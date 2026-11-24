/**
 * Relay bodies (Phase 3 §4): what a phone and a Pi say to each other THROUGH the
 * signaling server. The server sees only base64url(utf8(JSON)); it never decodes it.
 * Every body has a `k` (kind). Unknown or invalid bodies are dropped / rejected.
 */
import { z } from 'zod';
import { b64urlDecode, b64urlEncode, fromUtf8, utf8 } from './encoding.js';

/** Keep bodies comfortably below the server's relay limit (15 KiB of base64url). */
export const MAX_RELAY_BODY_BYTES = 12 * 1024;

const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/, 'must be base64url');
/** 16..64 random bytes, base64url (22..86 chars). */
const nonce = b64.min(22).max(86);
const sig = b64.length(86); // 64-byte P1363 signature
const deviceIdLike = z.string().regex(/^[a-z2-7]{52}$/);
const sdp = z.string().min(10).max(10_000);

export const PairRequestSchema = z.object({
  k: z.literal('pair.request'),
  phoneSpki: b64.min(80).max(200),
  proof: b64.length(43), // 32-byte HMAC
  challenge: b64.length(22), // 16 bytes
  label: z.string().min(1).max(40),
}).strict();

export const PairAcceptSchema = z.object({ k: z.literal('pair.accept'), piSpki: b64.min(80).max(200), signature: sig }).strict();
export const PairRejectSchema = z.object({ k: z.literal('pair.reject'), reason: z.literal('rejected') }).strict();

export const SessionHelloSchema = z.object({ k: z.literal('session.hello'), phoneId: deviceIdLike, np: nonce }).strict();
export const SessionChallengeSchema = z.object({ k: z.literal('session.challenge'), nc: nonce }).strict();
export const SessionOfferSchema = z.object({ k: z.literal('session.offer'), sdp, sig }).strict();
export const SessionAnswerSchema = z.object({ k: z.literal('session.answer'), sdp, sig }).strict();
export const SessionRejectSchema = z.object({ k: z.literal('session.reject'), reason: z.literal('rejected') }).strict();

/** Bodies a Pi accepts from a phone. */
export const PhoneToPiBodySchema = z.discriminatedUnion('k', [PairRequestSchema, SessionHelloSchema, SessionOfferSchema]);
/** Bodies a phone accepts from a Pi. */
export const PiToPhoneBodySchema = z.discriminatedUnion('k', [PairAcceptSchema, PairRejectSchema, SessionChallengeSchema, SessionAnswerSchema, SessionRejectSchema]);

export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PhoneToPiBody = z.infer<typeof PhoneToPiBodySchema>;
export type PiToPhoneBody = z.infer<typeof PiToPhoneBodySchema>;

/** body -> base64url(utf8(JSON)) for a relay `payload`. */
export function encodeRelayBody(body: PhoneToPiBody | PiToPhoneBody): string {
  return b64urlEncode(utf8(JSON.stringify(body)));
}

/** relay `payload` -> validated body, or undefined. */
export function decodeRelayBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, payload: string): T | undefined {
  if (payload.length > Math.ceil((MAX_RELAY_BODY_BYTES * 4) / 3)) return undefined;
  const bytes = b64urlDecode(payload);
  const text = bytes && fromUtf8(bytes);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : undefined;
}
