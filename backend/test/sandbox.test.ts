import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSandbox, patchSandbox } from '../src/integrations/zomboid-files/sandbox';

const realLua = fs.readFileSync(path.join(__dirname, 'fixtures/servertest_SandboxVars.lua'), 'utf8');

describe('parseSandbox (real SandboxVars.lua fixture)', () => {
  it('parses top-level scalars', () => {
    const s = parseSandbox(realLua);
    expect(s.values.Zombies).toBe(4);
    expect(s.values.DayLength).toBe(4);
    expect(s.values.ZombieVoronoiNoise).toBe(true);
  });
  it('parses nested table values (dotted paths)', () => {
    const s = parseSandbox(realLua);
    expect(s.values['ZombieLore.Speed']).toBe(4);
    expect(s.values['ZombieLore.Transmission']).toBe(1);
  });
  it('parses many entries', () => {
    expect(parseSandbox(realLua).entries.size).toBeGreaterThan(200);
  });
});

describe('patchSandbox', () => {
  it('is byte-identical for an empty patch (round-trip safety)', () => {
    const s = parseSandbox(realLua);
    expect(patchSandbox(s, {})).toBe(realLua);
  });

  it('changes only the targeted value and keeps the file re-parseable', () => {
    const s = parseSandbox(realLua);
    const out = patchSandbox(s, { Zombies: 2, 'ZombieLore.Speed': 1 });
    const s2 = parseSandbox(out);
    expect(s2.values.Zombies).toBe(2);
    expect(s2.values['ZombieLore.Speed']).toBe(1);
    // Same number of entries preserved.
    expect(s2.entries.size).toBe(s.entries.size);
    // Untouched neighbour preserved.
    expect(s2.values.DayLength).toBe(s.values.DayLength);
  });

  it('preserves float vs int formatting', () => {
    const src = 'SandboxVars = {\n    A = 1.0,\n    B = 5,\n    C = true,\n}\n';
    const s = parseSandbox(src);
    const out = patchSandbox(s, { A: 2, B: 9, C: false });
    expect(out).toContain('A = 2.0');
    expect(out).toContain('B = 9');
    expect(out).toContain('C = false');
  });

  it('rejects unknown paths', () => {
    const s = parseSandbox(realLua);
    expect(() => patchSandbox(s, { NopeNotAKey: 1 })).toThrow();
  });
});
