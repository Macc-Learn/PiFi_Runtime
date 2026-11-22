/** The only PresenceStore in Phase 2: a Map. Presence is lost on restart and rebuilt as Pis reconnect. */
import type { PiConnection, PresenceStore } from './PresenceStore.js';

export class InMemoryPresenceStore implements PresenceStore {
  private readonly online = new Map<string, PiConnection>();

  async setOnline(deviceId: string, conn: PiConnection): Promise<void> {
    this.online.set(deviceId, conn);
  }

  async setOffline(deviceId: string, conn: PiConnection): Promise<void> {
    if (this.online.get(deviceId) === conn) this.online.delete(deviceId);
  }

  async isOnline(deviceId: string): Promise<boolean> {
    return this.online.has(deviceId);
  }

  async getConnection(deviceId: string): Promise<PiConnection | undefined> {
    return this.online.get(deviceId);
  }

  async count(): Promise<number> {
    return this.online.size;
  }
}
