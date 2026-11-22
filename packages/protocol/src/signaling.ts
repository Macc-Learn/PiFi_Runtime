/**
 * Signaling protocol (Phase 2): messages between the central signaling server,
 * Pis and phones. JSON text frames: { v: 1, type, ... }.
 *
 * Trust rule baked into the shapes: relay `payload` is an opaque base64url blob.
 * The server only checks that it is a string of the right alphabet and size; it
 * never decodes it.
 */
import { z } from 'zod';
import { DEVICE_ID_REGEX } from './crypto.js';

export const SIGNAL_PROTOCOL_VERSION = 1 as const;

/** Close codes. They do not collide with the app-socket codes 4001-4005. */
export const SignalCloseCode = {
  REGISTRATION_FAILED: 4010,
  REPLACED: 4011,
  RATE_LIMITED: 4012,
  PROTOCOL_VIOLATION: 4013,
  SERVER_RESTARTING: 4100,
} as const;

/** Largest WebSocket frame the server accepts. */
export const MAX_SIGNAL_FRAME_BYTES = 16 * 1024;
/** Largest relay payload (base64url characters); leaves room for the envelope inside one frame. */
export const MAX_RELAY_PAYLOAD_CHARS = 15 * 1024;

/** Error codes the server sends in `error` messages. */
export type SignalErrorCode = 'target-offline' | 'peer-gone' | 'payload-too-large' | 'rate-limited' | 'target-mismatch' | 'not-registered';

/**
 * The exact bytes a Pi signs to register:
 *   UTF-8("pifi-register-v1") || UTF-8(nonce as sent, base64url) || UTF-8(deviceId)
 * All three parts have fixed lengths (16, 43, 52), so the concatenation is unambiguous.
 */
export const REGISTER_CONTEXT = 'pifi-register-v1';
export function registrationMessage(nonce: string, deviceId: string): Buffer {
  return Buffer.from(REGISTER_CONTEXT + nonce + deviceId, 'utf8');
}

const v = z.literal(SIGNAL_PROTOCOL_VERSION);
const b64url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'must be base64url');
const deviceId = z.string().regex(DEVICE_ID_REGEX, 'must be a 52-char base32 deviceId');
const peerId = z.string().regex(/^[0-9a-f]{32}$/, 'must be a 32-char hex peerId');
/** The length cap is checked separately so the server can answer `payload-too-large` instead of hanging up. */
const payload = b64url;

// ---- Pi -> server ----
export const PiHelloSchema = z.object({ v, type: z.literal('pi.hello'), deviceId, publicKey: b64url.max(400) }).strict();
export const PiAuthSchema = z.object({ v, type: z.literal('pi.auth'), signature: b64url.length(86) }).strict();
export const PiRelaySchema = z.object({ v, type: z.literal('relay'), peerId, payload }).strict();

// ---- phone -> server ----
export const QuerySchema = z.object({ v, type: z.literal('query'), deviceId }).strict();
export const PhoneRelaySchema = z.object({ v, type: z.literal('relay'), deviceId, payload }).strict();

// ---- server -> Pi ----
export const ChallengeSchema = z.object({ v, type: z.literal('challenge'), nonce: b64url }).strict();
export const RegisteredSchema = z.object({ v, type: z.literal('registered'), deviceId }).strict();
export const ToPiRelaySchema = PiRelaySchema; // same shape: { peerId, payload }
export const SignalErrorSchema = z.object({ v, type: z.literal('error'), code: z.string(), message: z.string() }).strict();

// ---- server -> phone ----
export const StatusSchema = z.object({ v, type: z.literal('status'), deviceId, online: z.boolean() }).strict();
export const ToPhoneRelaySchema = PhoneRelaySchema; // same shape: { deviceId, payload }

/** Messages that may open a connection (they decide its role). */
export const FirstMessageSchema = z.union([PiHelloSchema, QuerySchema, PhoneRelaySchema]);
/** Messages a Pi may send after `pi.hello`. */
export const PiFollowupSchema = z.union([PiAuthSchema, PiRelaySchema]);
/** Messages a phone may send. */
export const PhoneMessageSchema = z.union([QuerySchema, PhoneRelaySchema]);
/** What a Pi can receive. */
export const ServerToPiSchema = z.discriminatedUnion('type', [ChallengeSchema, RegisteredSchema, ToPiRelaySchema, SignalErrorSchema]);
/** What a phone can receive. */
export const ServerToPhoneSchema = z.discriminatedUnion('type', [StatusSchema, ToPhoneRelaySchema, SignalErrorSchema]);

export type PiHello = z.infer<typeof PiHelloSchema>;
export type FirstMessage = z.infer<typeof FirstMessageSchema>;
export type PiFollowup = z.infer<typeof PiFollowupSchema>;
export type PhoneMessage = z.infer<typeof PhoneMessageSchema>;
export type ServerToPi = z.infer<typeof ServerToPiSchema>;
export type ServerToPhone = z.infer<typeof ServerToPhoneSchema>;

/** JSON-parse + validate. Returns undefined for anything invalid (callers close with 4013). */
export function parseSignal<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): T | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : undefined;
}
