import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/integrations/runtime';
import { AmpRuntimeAdapter } from '../src/integrations/runtime/amp.adapter';
import { StandaloneRuntimeAdapter } from '../src/integrations/runtime/standalone.adapter';
import type { RuntimeState } from '../src/integrations/runtime/types';

const STATES: RuntimeState[] = ['running', 'stopped', 'starting', 'stopping', 'restarting', 'updating', 'unknown'];

describe('runtime adapter selection', () => {
  it('selects the AMP adapter for PZ_RUNTIME=amp', () => {
    const r = createRuntime('amp');
    expect(r.name).toBe('amp');
    expect(r).toBeInstanceOf(AmpRuntimeAdapter);
  });
  it('selects the standalone adapter for standalone/none/custom', () => {
    for (const n of ['standalone', 'none', 'custom']) {
      const r = createRuntime(n);
      expect(r.name).toBe('standalone');
      expect(r).toBeInstanceOf(StandaloneRuntimeAdapter);
    }
  });
  it('defaults to AMP for an unknown runtime name', () => {
    expect(createRuntime('bogus').name).toBe('amp');
  });
});

describe('runtime capabilities model', () => {
  it('AMP: lifecycle+metrics+update, settings NOT durable (AMP regenerates ini)', () => {
    expect(createRuntime('amp').capabilities()).toEqual({
      runtime: 'amp',
      lifecycle: true,
      metrics: true,
      update: true,
      durableServerSettings: false,
    });
  });
  it('standalone: metrics only, no lifecycle/update, settings ARE durable', () => {
    expect(createRuntime('standalone').capabilities()).toEqual({
      runtime: 'standalone',
      lifecycle: false,
      metrics: true,
      update: false,
      durableServerSettings: true,
    });
  });
});

describe('standalone runtime (usable without AMP)', () => {
  it('reports a valid state and metrics from the OS', async () => {
    const r = new StandaloneRuntimeAdapter();
    const status = await r.getStatus();
    expect(STATES).toContain(status.state);
    expect(status.source).toBe('proc');
    const m = await r.getMetrics();
    expect(m).toHaveProperty('cpuPercent');
    expect(m).toHaveProperty('memoryBytes');
    expect(m.source).toBe('proc');
  });
  it('rejects lifecycle operations with NOT_SUPPORTED', async () => {
    const r = new StandaloneRuntimeAdapter();
    await expect(r.start()).rejects.toMatchObject({ code: 'NOT_SUPPORTED', status: 501 });
    await expect(r.stop()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(r.restart()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(r.update).toBeUndefined();
  });
});

describe('AMP adapter', () => {
  it('exposes the generic runtime contract', async () => {
    const r = new AmpRuntimeAdapter();
    expect(r.name).toBe('amp');
    expect(typeof r.start).toBe('function');
    expect(typeof r.update).toBe('function');
    const status = await r.getStatus();
    expect(STATES).toContain(status.state);
    expect(typeof status.source).toBe('string');
  });
});
