import { amp } from '../amp/service';
import type { InstanceStatus } from '../amp/types';
import type {
  RuntimeCapabilities,
  RuntimeMetrics,
  RuntimeStatus,
  ServerRuntimeAdapter,
} from './types';

/**
 * AMP runtime adapter. This is the ONLY place (besides the amp integration it
 * wraps) that knows about AMP. It maps the AMP-specific status into the generic
 * runtime contract.
 *
 * durableServerSettings=false: AMP regenerates servertest.ini from its own
 * GenericModule settings when it (re)starts the process, so panel writes to
 * AMP-owned ini keys are not guaranteed durable across an AMP restart. This is
 * represented purely as an adapter capability — the configuration store remains
 * the Project Zomboid files, not AMP.
 */
export class AmpRuntimeAdapter implements ServerRuntimeAdapter {
  readonly name = 'amp';
  private cache: { at: number; value: InstanceStatus } | null = null;

  capabilities(): RuntimeCapabilities {
    return { runtime: 'amp', lifecycle: true, metrics: true, update: true, durableServerSettings: false };
  }

  /**
   * Single underlying fetch shared by getStatus + getMetrics (they are usually
   * called together). A 1s cache also prevents two back-to-back /proc samples
   * from corrupting the CPU delta.
   */
  private async snapshot(): Promise<InstanceStatus> {
    if (this.cache && Date.now() - this.cache.at < 1000) return this.cache.value;
    const value = await amp.getStatus();
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

  start(): Promise<void> {
    return amp.start();
  }
  stop(): Promise<void> {
    return amp.stop();
  }
  restart(): Promise<void> {
    return amp.restart();
  }
  update(): Promise<void> {
    return amp.update();
  }
  healthy(): Promise<boolean> {
    return amp.healthy();
  }
}
