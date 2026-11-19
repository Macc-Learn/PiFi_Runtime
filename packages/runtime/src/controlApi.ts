/**
 * Localhost HTTP control API (spec §17). Separate port from the app socket.
 *
 * It exists so Phase 1 can be driven and tested without a phone. In later
 * phases start/stop will come over the authenticated P2P channel instead, and
 * the central server will never get this power.
 *
 * Defences: bound to 127.0.0.1, bearer admin token on every request, requests
 * with an Origin header are refused (a browser tab can't call it), and the Host
 * header must be a loopback name (blocks DNS-rebinding tricks).
 */
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_NAME_REGEX } from '@pifi/protocol';
import type { AppManager } from './appManager.js';
import type { Config } from './config.js';
import { PifiError } from './errors.js';
import type { Logger } from './logger.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** Read the admin token, creating it (mode 0600, owner-only) on first run. */
export async function loadOrCreateAdminToken(home: string): Promise<string> {
  const file = path.join(home, 'admin.token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  await mkdir(home, { recursive: true });
  const token = randomBytes(32).toString('hex');
  await writeFile(file, token + '\n', { mode: 0o600 });
  return token;
}

/** Compare via SHA-256 digests so both sides are the same length for timingSafeEqual. */
function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(header.slice('Bearer '.length).trim()).digest();
  return timingSafeEqual(a, b);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new PifiError('BAD_REQUEST', 'request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PifiError('BAD_REQUEST', 'body is not valid JSON', 400);
  }
}

export interface ControlHooks {
  /** Re-scan registered-apps and return how many apps/errors were found. */
  reload: () => Promise<{ apps: number; errors: Array<{ dir: string; error: string }> }>;
  startedAt: number;
  version: string;
}

export class ControlApi {
  private server: http.Server;
  private _port = 0;

  constructor(
    private config: Config,
    private manager: AppManager,
    private adminToken: string,
    private hooks: ControlHooks,
    private log: Logger,
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get port(): number {
    return this._port;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.controlPort, '127.0.0.1', () => {
        const addr = this.server.address();
        this._port = typeof addr === 'object' && addr ? addr.port : this.config.controlPort;
        this.log.info(`control API listening on http://127.0.0.1:${this._port}`);
        resolve(this._port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.headers.origin !== undefined) throw new PifiError('UNAUTHORIZED', 'browser requests are not allowed', 403);
      if (!isLoopbackHost(req.headers.host)) throw new PifiError('UNAUTHORIZED', 'bad Host header', 403);
      if (!tokenMatches(this.adminToken, req.headers.authorization)) {
        throw new PifiError('UNAUTHORIZED', 'missing or wrong admin token', 401);
      }
      const result = await this.route(req);
      this.send(res, 200, result);
    } catch (err) {
      if (err instanceof PifiError) {
        this.send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        this.log.error(`control API error: ${err instanceof Error ? err.message : err}`);
        this.send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      }
    }
  }

  private async route(req: http.IncomingMessage): Promise<unknown> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const p = url.pathname;

    if (method === 'GET' && p === '/status') {
      const s = await this.manager.status();
      return {
        version: this.hooks.version,
        uptimeMs: Date.now() - this.hooks.startedAt,
        dev: this.config.dev,
        memory: s.memory,
        apps: s.apps,
      };
    }
    if (method === 'GET' && p === '/apps') return { apps: this.manager.list() };
    if (method === 'POST' && p === '/reload') return this.hooks.reload();

    const m = /^\/apps\/([^/]+)(?:\/(start|stop|restart|request))?$/.exec(p);
    if (m) {
      const name = m[1] as string;
      const action = m[2];
      if (!APP_NAME_REGEX.test(name)) throw new PifiError('NOT_FOUND', 'no such app', 404);
      if (!action && method === 'GET') return this.manager.detail(name); // detail never includes the token
      if (action === 'start' && method === 'POST') return this.manager.start(name);
      if (action === 'stop' && method === 'POST') return this.manager.stop(name, { hard: url.searchParams.get('hard') === 'true' });
      if (action === 'restart' && method === 'POST') return this.manager.restart(name);
      if (action === 'request' && method === 'POST') {
        const body = (await readJsonBody(req)) as { payload?: unknown };
        return { payload: await this.manager.request(name, body.payload) };
      }
    }
    throw new PifiError('NOT_FOUND', `no route for ${method} ${p}`, 404);
  }
}
