/**
 * Who is online (Phase 2 §6).
 *
 * Every method is async from day one so a Redis-backed store can drop in
 * without changing callers. Note for that future: Redis can't hold a live
 * socket, so it would store deviceId -> instanceId (with a TTL refreshed by
 * keepalives) and route messages between instances over pub/sub; getConnection
 * would likely become deliver(deviceId, message). That change is accepted.
 */
export interface PiConnection {
  send(message: unknown): void;
  close(code: number, reason?: string): void;
}

export interface PresenceStore {
  setOnline(deviceId: string, conn: PiConnection): Promise<void>;
  /** Only removes the entry if `conn` is still the registered one (a newer connection must survive the old one's close). */
  setOffline(deviceId: string, conn: PiConnection): Promise<void>;
  isOnline(deviceId: string): Promise<boolean>;
  getConnection(deviceId: string): Promise<PiConnection | undefined>;
  count(): Promise<number>;
}
