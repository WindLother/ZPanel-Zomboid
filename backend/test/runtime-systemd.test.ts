import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRuntime } from '../src/integrations/runtime';
import { SystemdRuntimeAdapter } from '../src/integrations/runtime/systemd.adapter';
import { AmpRuntimeAdapter } from '../src/integrations/runtime/amp.adapter';
import { StandaloneRuntimeAdapter } from '../src/integrations/runtime/standalone.adapter';
import { systemdService } from '../src/integrations/systemd/service';
import type { RuntimeState } from '../src/integrations/runtime/types';

const STATES: RuntimeState[] = ['running', 'stopped', 'starting', 'stopping', 'restarting', 'updating', 'unknown'];

describe('runtime adapter selection includes systemd (all three coexist)', () => {
  it('PZ_RUNTIME=systemd selects the SystemdRuntimeAdapter', () => {
    const r = createRuntime('systemd');
    expect(r.name).toBe('systemd');
    expect(r).toBeInstanceOf(SystemdRuntimeAdapter);
  });
  it('amp and standalone adapters are NOT removed', () => {
    expect(createRuntime('amp')).toBeInstanceOf(AmpRuntimeAdapter);
    expect(createRuntime('standalone')).toBeInstanceOf(StandaloneRuntimeAdapter);
  });
});

describe('SystemdRuntimeAdapter capabilities + contract', () => {
  it('exposes the runtime capabilities (lifecycle+metrics, no update, durable settings)', () => {
    expect(new SystemdRuntimeAdapter().capabilities()).toEqual({
      runtime: 'systemd',
      lifecycle: true,
      metrics: true,
      update: false,
      durableServerSettings: true,
    });
  });
  it('implements the ServerRuntimeAdapter contract', () => {
    const r = new SystemdRuntimeAdapter();
    for (const m of ['getStatus', 'getMetrics', 'start', 'stop', 'restart', 'healthy', 'capabilities']) {
      expect(typeof (r as any)[m]).toBe('function');
    }
    // update is intentionally absent (capabilities.update=false).
    expect((r as any).update).toBeUndefined();
  });
  it('getStatus returns a valid state from systemd (error-safe)', async () => {
    const s = await new SystemdRuntimeAdapter().getStatus();
    expect(STATES).toContain(s.state);
    expect(s.source).toBe('systemd');
  });
  it('getMetrics returns the metrics shape', async () => {
    const m = await new SystemdRuntimeAdapter().getMetrics();
    for (const k of ['cpuPercent', 'memoryBytes', 'memoryLimitBytes', 'uptimeSeconds', 'source']) {
      expect(m).toHaveProperty(k);
    }
    expect(m.source).toBe('proc');
  });
});

describe('systemd service: fixed unit + verb allowlist (no injection)', () => {
  it('controls a FIXED unit name from config, never a request value', () => {
    expect(typeof systemdService.unit).toBe('string');
    expect(systemdService.unit).toMatch(/\.service$/);
  });
  it('isActive resolves to a known systemd state, even if the unit is missing', async () => {
    const s = await systemdService.isActive();
    expect(['active', 'activating', 'deactivating', 'inactive', 'failed', 'unknown']).toContain(s);
  });
  it('source enforces a hard verb allowlist and never interpolates a unit from input', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/integrations/systemd/service.ts'), 'utf8');
    // Verbs are a fixed Set; the unit comes from env (server config), not a param.
    expect(src).toMatch(/ALLOWED_VERBS\s*=\s*new Set/);
    expect(src).toMatch(/const UNIT = env\.SYSTEMD_UNIT/);
    // The command is built as a fixed argv array (systemctl, verb, UNIT) and run
    // via spawn — never a shell, never string-concatenated from a request value.
    expect(src).toMatch(/\['systemctl', verb, UNIT\]/);
    expect(src).toMatch(/spawn\(cmd, args/);
    expect(src).not.toMatch(/child_process'\)\.exec|shell:\s*true/);
  });
});

describe('no AMP coupling in the systemd runtime path', () => {
  it('systemd adapter + service never import AMP', () => {
    for (const f of ['src/integrations/runtime/systemd.adapter.ts', 'src/integrations/systemd/service.ts']) {
      const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(text).not.toMatch(/integrations\/amp|ampinstmgr|InstanceStatus/);
    }
  });
});
