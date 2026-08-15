import { sampleProcess } from '../os/proc';
import { systemdService, type SystemdState } from '../systemd/service';
import type {
  RuntimeCapabilities,
  RuntimeMetrics,
  RuntimeState,
  RuntimeStatus,
  ServerRuntimeAdapter,
} from './types';

/**
 * systemd runtime adapter — controls a standalone Project Zomboid server run as
 * a dedicated systemd unit (no AMP). Lifecycle goes through the fixed-unit,
 * verb-allowlisted systemd service; status comes from `systemctl is-active`;
 * metrics come from observing the PZ process via /proc (matched by the
 * configured server name, so it never sees the AMP server).
 *
 * durableServerSettings=true: nothing regenerates the PZ config files here, so
 * panel writes to <servername>.ini / SandboxVars are durable.
 *
 * This adapter sits alongside AmpRuntimeAdapter and StandaloneRuntimeAdapter —
 * none replace each other; PZ_RUNTIME selects one.
 */
function mapState(s: SystemdState): RuntimeState {
  switch (s) {
    case 'active':
      return 'running';
    case 'activating':
      return 'starting';
    case 'deactivating':
      return 'stopping';
    case 'inactive':
    case 'failed':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export class SystemdRuntimeAdapter implements ServerRuntimeAdapter {
  readonly name = 'systemd';

  capabilities(): RuntimeCapabilities {
    return { runtime: 'systemd', lifecycle: true, metrics: true, update: false, durableServerSettings: true };
  }

  async getStatus(): Promise<RuntimeStatus> {
    return { state: mapState(await systemdService.isActive()), source: 'systemd' };
  }

  async getMetrics(): Promise<RuntimeMetrics> {
    const p = await sampleProcess();
    return {
      cpuPercent: p.cpuPercent,
      memoryBytes: p.memoryBytes,
      memoryLimitBytes: p.memoryLimitBytes,
      uptimeSeconds: p.uptimeSeconds,
      source: 'proc',
    };
  }

  async start(): Promise<void> {
    await systemdService.start();
  }
  async stop(): Promise<void> {
    await systemdService.stop();
  }
  async restart(): Promise<void> {
    await systemdService.restart();
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
