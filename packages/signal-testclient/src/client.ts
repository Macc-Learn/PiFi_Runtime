/**
 * What a phone will do, minus the browser: talk to the signaling server as an
 * anonymous phone connection. Used by the CLI and by the end-to-end test.
 */
import { WebSocket } from 'ws';
import { fromBase64url, parseSignal, ServerToPhoneSchema, SIGNAL_PROTOCOL_VERSION, toBase64url, type ServerToPhone } from '@pifi/protocol';

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Wait for the next valid server message, or fail on timeout/close. */
function nextMessage(ws: WebSocket, timeoutMs: number): Promise<ServerToPhone> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`no reply within ${timeoutMs} ms`)); }, timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      const msg = parseSignal(ServerToPhoneSchema, data.toString());
      if (!msg) return;
      cleanup();
      resolve(msg);
    };
    const onClose = (code: number): void => { cleanup(); reject(new Error(`server closed the connection (${code})`)); };
    const cleanup = (): void => { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/** `query`: is this Pi online? */
export async function queryStatus(url: string, deviceId: string, timeoutMs = 5000): Promise<boolean> {
  const ws = await open(url);
  try {
    ws.send(JSON.stringify({ v: SIGNAL_PROTOCOL_VERSION, type: 'query', deviceId }));
    const msg = await nextMessage(ws, timeoutMs);
    if (msg.type === 'error') throw new Error(`${msg.code}: ${msg.message}`);
    if (msg.type !== 'status') throw new Error(`unexpected reply: ${msg.type}`);
    return msg.online;
  } finally {
    ws.close(1000);
  }
}

/** Send the dev echo payload to a Pi and return what it echoes back. */
export async function echo(url: string, deviceId: string, data: unknown, timeoutMs = 5000): Promise<unknown> {
  const ws = await open(url);
  try {
    const payload = toBase64url(Buffer.from(JSON.stringify({ kind: 'echo', data }), 'utf8'));
    ws.send(JSON.stringify({ v: SIGNAL_PROTOCOL_VERSION, type: 'relay', deviceId, payload }));
    const msg = await nextMessage(ws, timeoutMs);
    if (msg.type === 'error') throw new Error(`${msg.code}: ${msg.message}`);
    if (msg.type !== 'relay') throw new Error(`unexpected reply: ${msg.type}`);
    const bytes = fromBase64url(msg.payload);
    const reply = bytes ? (JSON.parse(bytes.toString('utf8')) as { kind?: string; data?: unknown }) : undefined;
    if (reply?.kind !== 'echo-reply') throw new Error('reply was not an echo-reply');
    return reply.data;
  } finally {
    ws.close(1000);
  }
}
