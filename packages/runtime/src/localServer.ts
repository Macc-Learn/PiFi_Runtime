/**
 * The local WebSocket server apps connect to (spec §5 and §11).
 *
 * Security properties enforced here:
 *  - listens on 127.0.0.1 only, so nothing off the machine can reach it
 *  - rejects any connection that carries an `Origin` header: browsers always add
 *    one, so this stops a web page you happen to visit from talking to the port
 *  - first message must be a valid `hello` with the per-launch token, within a few seconds
 *  - one connection per app; frames limited by maxPayload
 *
 * Note on oversized frames: the `ws` library enforces maxPayload itself and closes
 * with the standard code 1009 ("message too big") rather than our 4005.
 */
import http from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { CloseCode, parseAppMessage } from '@pifi/protocol';
import type { AppManager } from './appManager.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

function rawToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class LocalServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private _port = 0;

  constructor(private config: Config, private manager: AppManager, private log: Logger) {
    // Plain HTTP requests get a 404; only WebSocket upgrades on /app are meaningful.
    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('PiFi app socket: use WebSocket at /app\n');
    });
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/app', maxPayload: config.maxPayload });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  get port(): number {
    return this._port;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      // '127.0.0.1' (never '0.0.0.0'): reachable only from this machine.
      this.httpServer.listen(this.config.appPort, '127.0.0.1', () => {
        const addr = this.httpServer.address();
        this._port = typeof addr === 'object' && addr ? addr.port : this.config.appPort;
        this.log.info(`app socket listening on ws://127.0.0.1:${this._port}/app`);
        resolve(this._port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => this.httpServer.close(() => resolve()));
    });
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    if (req.headers.origin !== undefined) {
      this.log.warn('rejected app connection carrying an Origin header');
      ws.close(CloseCode.ORIGIN_NOT_ALLOWED, 'Origin not allowed');
      return;
    }

    let appName: string | undefined;
    let closing = false;
    const closeWith = (code: number, reason: string): void => {
      closing = true;
      ws.close(code, reason);
    };

    // Don't let silent connections pile up: say hello soon or go away.
    const helloTimer = setTimeout(() => {
      if (!appName) closeWith(CloseCode.PROTOCOL_VIOLATION, 'hello timeout');
    }, this.config.helloTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (closing) return;
      if (isBinary) {
        // Stream data. Only after hello, and only from apps that declared "streams".
        if (!appName) return closeWith(CloseCode.PROTOCOL_VIOLATION, 'text frames only');
        return this.manager.onAppBinary(appName, ws, new Uint8Array(rawToBuffer(data)));
      }
      const parsed = parseAppMessage(rawToString(data));
      if (!parsed.ok) return closeWith(CloseCode.PROTOCOL_VIOLATION, parsed.reason.slice(0, 100));
      const msg = parsed.message;

      if (!appName) {
        if (msg.type !== 'hello') return closeWith(CloseCode.PROTOCOL_VIOLATION, 'first message must be hello');
        clearTimeout(helloTimer);
        const verdict = this.manager.authenticateHello(msg.payload.name, msg.payload.token);
        if (verdict === 'unknown-app') return closeWith(CloseCode.UNKNOWN_APP, 'unknown app');
        if (verdict === 'bad-token') return closeWith(CloseCode.BAD_TOKEN, 'bad token'); // never echo the token
        if (verdict === 'duplicate') return closeWith(CloseCode.DUPLICATE_CONNECTION, 'already connected');
        appName = msg.payload.name;
        this.manager.attachSocket(appName, ws, msg.payload.capabilities ?? []);
        return;
      }

      if (msg.type === 'hello') return closeWith(CloseCode.PROTOCOL_VIOLATION, 'duplicate hello');
      this.manager.onAppMessage(appName, ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (appName) this.manager.onSocketClosed(appName, ws);
    });
    ws.on('error', (err) => this.log.debug(`app socket error: ${err.message}`));
  }
}
