import { err } from '../../shared/errors';
import { sampleProcess } from '../os/proc';
import type {
  RuntimeCapabilities,
  RuntimeMetrics,
  RuntimeStatus,
  ServerRuntimeAdapter,
} from './types';

/**
 * Standalone runtime — the "without AMP" mode. Status and metrics come purely
 * from observing the OS process (/proc); there is no management API, so
 * lifecycle operations are not supported and fail honestly. This is what lets
 * the panel run against a Project Zomboid server started by systemd, docker, a
 * script, or by hand.
 *
 * durableServerSettings=true: nothing regenerates the PZ config files here, so
 * panel writes to servertest.ini ARE durable across a restart.
 *
 * A future systemd/docker adapter would extend this by implementing real
 * start/stop/restart and flipping `lifecycle` to true.
 */
export class StandaloneRuntimeAdapter implements ServerRuntimeAdapter {
  readonly name = 'standalone';
  private cache: { at: number; value: Awaited<ReturnType<typeof sampleProcess>> } | null = null;

  capabilities(): RuntimeCapabilities {
    return { runtime: 'standalone', lifecycle: false, metrics: true, update: false, durableServerSettings: true };
  }

  private async snapshot() {
    if (this.cache && Date.now() - this.cache.at < 1000) return this.cache.value;
    const value = await sampleProcess();
    this.cache = { at: Date.now(), value };
    return value;
  }

  async getStatus(): Promise<RuntimeStatus> {
    const s = await this.snapshot();
    return { state: s.state, source: s.source };
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    const s = await this.snapshot();
    return {
      cpuPercent: s.cpuPercent,
      memoryBytes: s.memoryBytes,
      memoryLimitBytes: s.memoryLimitBytes,
      uptimeSeconds: s.uptimeSeconds,
      source: s.source,
    };
  }

  private unsupported(): never {
    throw err.notSupported("The 'standalone' runtime does not manage the server lifecycle (no AMP/systemd/docker adapter configured).");
  }
  // async so the error surfaces as a rejected promise, not a synchronous throw.
  async start(): Promise<void> {
    this.unsupported();
  }
  async stop(): Promise<void> {
    this.unsupported();
  }
  async restart(): Promise<void> {
    this.unsupported();
  }

  async healthy(): Promise<boolean> {
    try {
      await this.snapshot();
      return true;
    } catch {
      return false;
    }
  }
}
