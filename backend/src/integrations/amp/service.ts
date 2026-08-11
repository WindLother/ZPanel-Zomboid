import { logger } from '../../shared/logger';
import { sampleProcess } from '../os/proc';
import { AmpApiClient, buildAmpClient } from './client';
import { ampCli, ampCliAvailable } from './cli';
import type { InstanceStatus } from './types';

/**
 * Unified AMP lifecycle + status source. Prefers the official AMP HTTP API when
 * credentials are configured; otherwise falls back to the `ampinstmgr` CLI for
 * lifecycle and /proc for metrics. This is AMP-specific and is consumed ONLY by
 * the AmpRuntimeAdapter — no business module imports it directly. Transitional
 * state overlay now lives generically in the runtime layer.
 */
class AmpService {
  private readonly api: AmpApiClient | null = buildAmpClient();
  private lastError: string | null = null;

  get mode(): 'amp-api' | 'cli' | 'none' {
    if (this.api) return 'amp-api';
    if (ampCliAvailable()) return 'cli';
    return 'none';
  }

  /** Observed status (no transitional overlay — that is applied by the runtime). */
  async getStatus(): Promise<InstanceStatus> {
    if (this.api) {
      try {
        const status = await this.api.getStatus();
        this.lastError = null;
        return status;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        logger.debug({ err: this.lastError }, 'AMP API status failed; falling back to /proc');
      }
    }
    return sampleProcess();
  }

  async start(): Promise<void> {
    if (this.api) return this.api.start();
    await ampCli.start();
  }
  async stop(): Promise<void> {
    if (this.api) return this.api.stop();
    await ampCli.stop();
  }
  async restart(): Promise<void> {
    if (this.api) return this.api.restart();
    await ampCli.restart();
  }
  async update(): Promise<void> {
    if (this.api) return this.api.update();
    await ampCli.upgrade();
  }

  get status(): { mode: string; lastError: string | null } {
    return { mode: this.mode, lastError: this.lastError };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.getStatus();
      return true;
    } catch {
      return false;
    }
  }
}

export const amp = new AmpService();
