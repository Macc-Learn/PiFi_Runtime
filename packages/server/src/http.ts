/**
 * Plain HTTP surface: GET /healthz -> 200 "ok"; everything else -> 404.
 * WebSocket upgrades are accepted only on /ws.
 */
import type http from 'node:http';
import type { Duplex } from 'node:stream';

export function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/** Refuse an upgrade before it becomes a WebSocket. */
export function rejectUpgrade(socket: Duplex, status: 404 | 503): void {
  socket.write(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The client IP for rate limiting. Behind Cloud Run (TRUST_PROXY=1) the platform
 * APPENDS the real client address to X-Forwarded-For, so we take the LAST entry:
 * earlier entries are whatever the client chose to send and can't be trusted.
 */
export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : header;
    const last = value?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
