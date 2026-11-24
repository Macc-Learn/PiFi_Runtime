/**
 * The MessagePort protocol between an app's page (inside the shell's sandboxed
 * iframe, using @pifi/client) and the shell (Phase 3 §10).
 *
 * It mirrors the wire frames, minus anything an app page must not control:
 * there is no `app` field (the shell sets it from the frame it created) and no
 * way to name a control op. Stream data travels as transferred ArrayBuffers.
 */
import { z } from 'zod';

export const PORT_PROTOCOL_VERSION = 1 as const;
/** Page -> parent window, once: "please give me a port". */
export const PORT_HELLO = 'pifi-hello';
/** Shell -> frame, once, carrying the MessagePort. */
export const PORT_HANDOFF = 'pifi-port';

/** Per-frame limits enforced by the shell. */
export const FRAME_LIMITS = {
  REQUESTS_PER_SEC: 50,
  BURST: 100,
  MAX_MESSAGE_BYTES: 64 * 1024,
  MAX_CHUNK_BYTES: 16 * 1024,
  /** Chunks a page may have in flight before waiting for `s.ack` (16 x 16 KiB = 256 KiB). */
  STREAM_WINDOW: 16,
} as const;

const id = z.string().min(1).max(32);
const sid = z.number().int().min(1).max(0x7fffffff);
const op = z.string().min(1).max(64);

/** Everything a page may send. Strict: unknown fields or kinds are refused. */
export const PageMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('req'), id, op, payload: z.unknown().optional() }).strict(),
  z.object({ t: z.literal('sub') }).strict(),
  z.object({ t: z.literal('unsub') }).strict(),
  z.object({ t: z.literal('s.open'), sid, op, meta: z.unknown().optional() }).strict(),
  z.object({ t: z.literal('s.data'), sid, data: z.instanceof(ArrayBuffer) }).strict(),
  z.object({ t: z.literal('s.end'), sid }).strict(),
  z.object({ t: z.literal('s.abort'), sid, reason: z.string().max(200) }).strict(),
]);
export type PageMessage = z.infer<typeof PageMessageSchema>;

export interface PortError {
  code: string;
  message: string;
}

/** Everything the shell sends to a page. */
export type ShellMessage =
  | { t: 'res'; id: string; ok: true; payload?: unknown }
  | { t: 'res'; id: string; ok: false; error: PortError }
  | { t: 'evt'; name: string; data?: unknown }
  | { t: 'status'; status: 'online' | 'reconnecting' }
  | { t: 's.ok'; sid: number }
  | { t: 's.reject'; sid: number; error: PortError }
  | { t: 's.data'; sid: number; data: ArrayBuffer }
  | { t: 's.ack'; sid: number }
  | { t: 's.end'; sid: number }
  | { t: 's.abort'; sid: number; reason: string };
