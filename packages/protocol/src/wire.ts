/**
 * Data-channel wire protocol v1 (Phase 3 §6): what flows over the direct
 * phone<->Pi WebRTC channel, after the session handshake authenticated it.
 *
 * Text frames are JSON (strictly validated, max 64 KiB). Binary frames carry
 * stream data: [u32 big-endian stream id][chunk], chunk max 16 KiB.
 */
import { z } from 'zod';
import { APP_NAME } from './names.js';

export const WIRE = {
  CHANNEL_LABEL: 'pifi',
  MAX_TEXT_BYTES: 64 * 1024,
  MAX_CHUNK_BYTES: 16 * 1024,
  MAX_INFLIGHT: 64,
  MAX_STREAMS: 16,
  /** Stop sending above this bufferedAmount... */
  BUFFER_HIGH: 1024 * 1024,
  /** ...and resume on `bufferedamountlow` at this threshold. */
  BUFFER_LOW: 256 * 1024,
  PING_INTERVAL_MS: 15_000,
  APP_REQUEST_TIMEOUT_MS: 30_000,
} as const;

const id = z.string().min(1).max(32);
const sid = z.number().int().min(1).max(0xffffffff);
const app = z.string().regex(APP_NAME);
const op = z.string().min(1).max(64);
const error = z.object({ code: z.string().max(64), message: z.string().max(1000) }).strict();

export const ReqFrame = z.object({ t: z.literal('req'), id, app: app.optional(), op, payload: z.unknown().optional() }).strict();
const ResOk = z.object({ t: z.literal('res'), id, ok: z.literal(true), payload: z.unknown().optional() }).strict();
const ResErr = z.object({ t: z.literal('res'), id, ok: z.literal(false), error }).strict();
export const EvtFrame = z.object({ t: z.literal('evt'), app, name: z.string().max(64), data: z.unknown().optional() }).strict();
const Sub = z.object({ t: z.literal('sub'), app }).strict();
const Unsub = z.object({ t: z.literal('unsub'), app }).strict();
const Ping = z.object({ t: z.literal('ping'), n: z.number() }).strict();
const Pong = z.object({ t: z.literal('pong'), n: z.number() }).strict();
const SOpen = z.object({ t: z.literal('s.open'), sid, app, op, meta: z.unknown().optional() }).strict();
const SOk = z.object({ t: z.literal('s.ok'), sid }).strict();
const SReject = z.object({ t: z.literal('s.reject'), sid, error }).strict();
const SEnd = z.object({ t: z.literal('s.end'), sid }).strict();
const SAbort = z.object({ t: z.literal('s.abort'), sid, reason: z.string().max(200) }).strict();

export const WireFrameSchema = z.union([ReqFrame, ResOk, ResErr, EvtFrame, Sub, Unsub, Ping, Pong, SOpen, SOk, SReject, SEnd, SAbort]);
export type WireFrame = z.infer<typeof WireFrameSchema>;
export type WireError = z.infer<typeof error>;

const textBytes = new TextEncoder();

/** Parse and validate a text frame; undefined means "malformed: close the session". */
export function parseWireFrame(text: string): WireFrame | undefined {
  if (text.length > WIRE.MAX_TEXT_BYTES || textBytes.encode(text).length > WIRE.MAX_TEXT_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = WireFrameSchema.safeParse(json);
  return r.success ? r.data : undefined;
}

/** [u32 sid][bytes]. Used on the data channel AND on the localhost app socket. */
export function encodeChunk(streamId: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  new DataView(out.buffer).setUint32(0, streamId, false);
  out.set(data, 4);
  return out;
}

export function decodeChunk(frame: Uint8Array): { sid: number; data: Uint8Array } | undefined {
  if (frame.length < 4 || frame.length > 4 + WIRE.MAX_CHUNK_BYTES) return undefined;
  const sid = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (sid === 0) return undefined;
  return { sid, data: frame.subarray(4) };
}
