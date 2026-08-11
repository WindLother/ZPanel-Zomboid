import { RconClient } from './client';
import { env } from '../../config/env';
import { err } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Owns a single reusable RCON connection and serializes commands through it, so
 * a burst of dashboard polls does not open dozens of sockets. Reconnects lazily
 * on the next command after a drop. The RCON password never leaves this module
 * and is never logged.
 */
class RconService {
  private client: RconClient | null = null;
  private connecting: Promise<RconClient> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastError: string | null = null;

  private get password(): string {
    const pw = env.PZ_RCON_PASSWORD;
    if (!pw) throw err.rcon('RCON is not configured (PZ_RCON_PASSWORD is unset).');
    return pw;
  }

  private async getClient(): Promise<RconClient> {
    if (this.client && this.client.connected) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new RconClient({
        host: env.PZ_RCON_HOST,
        port: env.PZ_RCON_PORT,
        password: this.password,
      });
      await client.connect();
      this.client = client;
      this.lastError = null;
      logger.debug('RCON connected');
      return client;
    })();
    try {
      return await this.connecting;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.client = null;
      throw e;
    } finally {
      this.connecting = null;
    }
  }

  /** Execute a validated command line, serialized against other callers. */
  async exec(command: string): Promise<string> {
    const run = this.queue.then(async () => {
      try {
        const client = await this.getClient();
        return await client.exec(command);
      } catch (e) {
        // Drop a poisoned client so the next call reconnects.
        this.client?.close();
        this.client = null;
        this.lastError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    });
    // Keep the chain alive regardless of individual failures.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<string>;
  }

  /** Lightweight health probe used by /api/system/connections. */
  async ping(): Promise<boolean> {
    try {
      await this.exec('players');
      return true;
    } catch {
      return false;
    }
  }

  get status(): { connected: boolean; lastError: string | null } {
    return { connected: Boolean(this.client?.connected), lastError: this.lastError };
  }

  shutdown(): void {
    this.client?.close();
    this.client = null;
  }
}

export const rcon = new RconService();
