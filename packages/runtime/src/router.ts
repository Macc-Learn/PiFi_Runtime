/**
 * Request/response correlation (spec "request/response routing").
 *
 * PiFi sends an app a `request` with a unique id and later gets a `response`
 * with the same id, possibly after other traffic. The Router remembers each
 * outstanding id as a pending Promise so the right caller gets the right answer.
 * Every app record owns one Router. Later, the P2P layer will use the same thing
 * to forward a phone's command to an app.
 */
import { randomUUID } from 'node:crypto';
import { PifiError } from './errors.js';

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class Router {
  private pending = new Map<string, Pending>();

  /** How many requests are waiting for an answer (tests check this returns to 0). */
  get size(): number {
    return this.pending.size;
  }

  /** Register a new outstanding request. The promise rejects if no response arrives in time. */
  create(timeoutMs: number): { id: string; promise: Promise<unknown> } {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Always remove the entry on timeout, otherwise a mute app leaks memory forever.
        this.pending.delete(id);
        reject(new PifiError('REQUEST_TIMEOUT', `no response within ${timeoutMs} ms`, 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Called when a `response` arrives. Returns false if the id is unknown (late or bogus). */
  settle(id: string, result: { payload?: unknown; error?: { code: string; message: string } }): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (result.error) {
      entry.reject(new PifiError('APP_ERROR', result.error.message, 502, result.error.code));
    } else {
      entry.resolve(result.payload);
    }
    return true;
  }

  /** Fail every outstanding request, e.g. because the app died. */
  rejectAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
