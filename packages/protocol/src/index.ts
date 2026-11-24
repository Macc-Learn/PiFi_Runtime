/**
 * @pifi/protocol — the local app protocol (spec §11).
 *
 * This is the contract between the PiFi runtime and an app process. Both the
 * runtime and the SDK import it, so they can never disagree about message shapes.
 * Apps written in other languages only need to follow the same JSON format.
 *
 * Everything is a JSON text frame over a WebSocket on 127.0.0.1:
 *   { "v": 1, "type": "...", "id": "...", "payload": ..., "error": { code, message } }
 */
import { z } from 'zod';
import { APP_NAME } from './names.js';

export const PROTOCOL_VERSION = 1 as const;

/**
 * Valid app names. Names become folder names and appear in log paths, so they
 * are kept to a tiny safe alphabet: no dots, slashes or uppercase. This is what
 * stops a manifest called "../../etc" from escaping the registry directory.
 */
export const APP_NAME_REGEX = APP_NAME;

/** WebSocket close codes PiFi uses. 4000-4999 is the range reserved for applications. */
export const CloseCode = {
  BAD_TOKEN: 4001,
  DUPLICATE_CONNECTION: 4002,
  UNKNOWN_APP: 4003,
  ORIGIN_NOT_ALLOWED: 4004,
  PROTOCOL_VIOLATION: 4005,
} as const;

/** How long a new connection has to send a valid `hello` before PiFi hangs up. */
export const HELLO_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const ErrorBodySchema = z.object({ code: z.string(), message: z.string() });
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Request ids are chosen by the sender; keep them short so nobody can bloat logs/maps. */
const IdSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// App -> PiFi
// ---------------------------------------------------------------------------

const HelloSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('hello'),
  payload: z.object({
    name: z.string(),
    token: z.string(),
    sdkVersion: z.string(),
    /** Optional features the app supports, e.g. ["streams"]. Old SDKs omit it. */
    capabilities: z.array(z.string().max(32)).max(16).optional(),
  }),
});

const ReadySchema = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('ready') });

const ResponseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('response'),
  id: IdSchema,
  payload: z.unknown().optional(),
  error: ErrorBodySchema.optional(),
});

const EventSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('event'),
  payload: z.object({ name: z.string(), data: z.unknown().optional() }),
});

const LogSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('log'),
  payload: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string().max(4000),
  }),
});

// ---------------------------------------------------------------------------
// Streams (Phase 3), both directions. Data travels as binary frames [u32 sid][bytes].
// Streams PiFi opens use odd sids, streams an app opens use even sids.
// ---------------------------------------------------------------------------

export const STREAMS_CAPABILITY = 'streams';
const sid = z.number().int().min(1).max(0xffffffff);

const StreamOpenSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('stream.open'),
  sid,
  op: z.string().min(1).max(64),
  meta: z.unknown().optional(),
  /** On app-opened streams: which phone session to open it towards (from a request's `session`). */
  session: z.string().max(64).optional(),
});
const StreamAcceptSchema = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('stream.accept'), sid });
const StreamRejectSchema = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('stream.reject'), sid, error: ErrorBodySchema });
const StreamEndSchema = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('stream.end'), sid });
const StreamAbortSchema = z.object({ v: z.literal(PROTOCOL_VERSION), type: z.literal('stream.abort'), sid, reason: z.string().max(200) });
const StreamSchemas = [StreamOpenSchema, StreamAcceptSchema, StreamRejectSchema, StreamEndSchema, StreamAbortSchema] as const;
export type StreamMessage = z.infer<(typeof StreamSchemas)[number]>;

export const AppMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  ReadySchema,
  ResponseSchema,
  EventSchema,
  LogSchema,
  ...StreamSchemas,
]);
export type AppMessage = z.infer<typeof AppMessageSchema>;
export type HelloMessage = z.infer<typeof HelloSchema>;

// ---------------------------------------------------------------------------
// PiFi -> App
// ---------------------------------------------------------------------------

const WelcomeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('welcome'),
  payload: z.object({ name: z.string() }),
});

const RequestSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('request'),
  id: IdSchema,
  payload: z.unknown().optional(),
  /** Phase 3: opaque id of the phone session that sent it (lets the app open a stream back). */
  session: z.string().max(64).optional(),
});

const ShutdownSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('shutdown'),
  payload: z.object({ graceMs: z.number(), reason: z.string() }),
});

const ProtocolErrorSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('error'),
  error: ErrorBodySchema,
});

export const PiMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  RequestSchema,
  ShutdownSchema,
  ProtocolErrorSchema,
  ...StreamSchemas,
]);
export type PiMessage = z.infer<typeof PiMessageSchema>;

// ---------------------------------------------------------------------------
// Parsing helpers (JSON text -> validated message)
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: string };

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    // Only report the first problem; this string may end up in a log line.
    const first = result.error.issues[0];
    return { ok: false, reason: `invalid message: ${first?.path.join('.') || 'root'} ${first?.message ?? ''}`.trim() };
  }
  return { ok: true, message: result.data };
}

/** Parse a frame the runtime received from an app. */
export function parseAppMessage(raw: string): ParseResult<AppMessage> {
  return parseWith<AppMessage>(AppMessageSchema, raw);
}

/** Parse a frame an app (or the SDK) received from the runtime. */
export function parsePiMessage(raw: string): ParseResult<PiMessage> {
  return parseWith<PiMessage>(PiMessageSchema, raw);
}

/** Serialize any protocol message to a text frame. */
export function encode(message: AppMessage | PiMessage): string {
  return JSON.stringify(message);
}

// Phase 1 revision + Phase 2 additions (Node-only: crypto uses node:crypto).
export * from './crypto.js';
export * from './signaling.js';
// Phase 3 (also available without node:* via '@pifi/protocol/browser').
export { b64urlDecode, b64urlEncode, bytesEqual, concatBytes, fromUtf8, utf8 } from './encoding.js';
export * from './signed.js';
export * from './relay.js';
export * from './wire.js';
