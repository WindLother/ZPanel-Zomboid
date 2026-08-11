import { env } from '../../config/env';
import { err } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { AmpRuntimeAdapter } from './amp.adapter';
import { StandaloneRuntimeAdapter } from './standalone.adapter';
import { SystemdRuntimeAdapter } from './systemd.adapter';
import { applyOperationOverlay } from './overlay';
import type {
  RuntimeCapabilities,
  RuntimeMetrics,
  RuntimeStatus,
  ServerRuntimeAdapter,
} from './types';

export type {
  RuntimeState,
  RuntimeStatus,
  RuntimeMetrics,
  RuntimeCapabilities,
  ServerRuntimeAdapter,
} from './types';

/** Build the adapter named by server-side config (PZ_RUNTIME). */
export function createRuntime(name: string = env.PZ_RUNTIME): ServerRuntimeAdapter {
  switch (name) {
    case 'amp':
      return new AmpRuntimeAdapter();
    case 'systemd':
      return new SystemdRuntimeAdapter();
    case 'standalone':
    case 'none':
    case 'custom':
      return new StandaloneRuntimeAdapter();
    default:
      logger.warn({ name }, `unknown PZ_RUNTIME "${name}"; defaulting to 'amp'`);
      return new AmpRuntimeAdapter();
  }
}

/**
 * Runtime facade used by the rest of the backend. Applies the generic
 * transitional-state overlay and gates lifecycle operations by capability so an
 * unsupported action fails with a clear NOT_SUPPORTED error rather than a crash.
 */
class Runtime implements ServerRuntimeAdapter {
  constructor(private readonly adapter: ServerRuntimeAdapter) {}

  get name(): string {
    return this.adapter.name;
  }
  capabilities(): RuntimeCapabilities {
    return this.adapter.capabilities();
  }

  async getStatus(): Promise<RuntimeStatus> {
    const s = await this.adapter.getStatus();
    return { ...s, state: applyOperationOverlay(s.state) };
  }
  getMetrics(): Promise<RuntimeMetrics> {
    return this.adapter.getMetrics();
  }

  private assertLifecycle(): void {
    if (!this.capabilities().lifecycle) {
      throw err.notSupported(`The '${this.name}' runtime does not support lifecycle operations.`);
    }
  }

  async start(): Promise<void> {
    this.assertLifecycle();
    return this.adapter.start();
  }
  async stop(): Promise<void> {
    this.assertLifecycle();
    return this.adapter.stop();
  }
  async restart(): Promise<void> {
    this.assertLifecycle();
    return this.adapter.restart();
  }
  async update(): Promise<void> {
    if (!this.capabilities().update || !this.adapter.update) {
      throw err.notSupported(`The '${this.name}' runtime does not support updates.`);
    }
    return this.adapter.update();
  }

  healthy(): Promise<boolean> {
    return this.adapter.healthy();
  }
}

export const runtime = new Runtime(createRuntime());
