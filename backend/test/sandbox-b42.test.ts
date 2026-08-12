import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSandbox, patchSandbox } from '../src/integrations/zomboid-files/sandbox';
import { SANDBOX_SCHEMA, SCHEMA_SOURCE } from '../src/modules/sandbox/schema.generated';
import { SANDBOX_BY_PATH, enumToLabel, labelToEnum } from '../src/modules/sandbox/mapping';
import { categoryFor, CATEGORY_ORDER } from '../src/modules/sandbox/categories';

/**
 * Build 42 sandbox coverage. The fixture is a REAL generated Build 42
 * SandboxVars.lua (structure + PZ's own metadata comments) with an extra
 * unknown "future vanilla" option and a nested mod section appended, so
 * preservation is proven against the real thing rather than a toy sample.
 *
 * The fixture's VALUES are one server's gameplay config and are never treated
 * as defaults — see the "schema default is informational" tests below.
 */
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'sandboxvars_b42.lua'), 'utf8');

// --- parser: types, nesting, fidelity ---------------------------------------
describe('parseSandbox: Build 42 structure', () => {
  const parsed = parseSandbox(FIXTURE);

  it('parses top-level scalars with their Lua types intact', () => {
    expect(parsed.values['Zombies']).toBe(4); // int
    expect(parsed.values['ZombieVoronoiNoise']).toBe(true); // bool
    expect(typeof parsed.values['ZombieVoronoiNoise']).toBe('boolean');
    expect(parsed.values['FoodLootNew']).toBeCloseTo(0.8); // float, as spelled in the fixture
    expect(parsed.values['LootItemRemovalList']).toBe(''); // empty string stays a string
    expect(typeof parsed.values['LootItemRemovalList']).toBe('string');
    expect(parsed.values['WorldItemRemovalList']).toContain('Base.Hat'); // non-empty string
  });

  it('parses every nested vanilla table by dotted path', () => {
    expect(parsed.values['Map.AllowMiniMap']).toBeTypeOf('boolean');
    expect(parsed.values['Basement.SpawnFrequency']).toBeTypeOf('number');
    expect(parsed.values['ZombieLore.Speed']).toBeTypeOf('number');
    expect(parsed.values['ZombieConfig.PopulationMultiplier']).toBeTypeOf('number');
    expect(parsed.values['MultiplierConfig.Global']).toBeTypeOf('number');
  });

  it('parses arbitrarily deep nesting (mod section with a nested table)', () => {
    expect(parsed.values['SomeMod.OptionA']).toBe(true);
    expect(parsed.values['SomeMod.OptionB']).toBe(5);
    expect(parsed.values['SomeMod.Nested.Deep']).toBeCloseTo(1.5);
  });

  it('never flattens a nested key into a literal dotted key in the file', () => {
    expect(FIXTURE).not.toMatch(/^\s*ZombieLore\.Speed\s*=/m);
    expect(FIXTURE).toMatch(/ZombieLore = \{/);
  });

  it('does not execute Lua (parser has no eval/Function/require of the data)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/integrations/zomboid-files/sandbox.ts'), 'utf8');
    expect(src).not.toMatch(/\beval\(|new Function|loadstring|vm\.runIn/);
  });
});

// --- writer: patch only what changed ----------------------------------------
describe('patchSandbox: surgical writes', () => {
  const parsed = parseSandbox(FIXTURE);

  it('changes the target value and leaves every other value semantically identical', () => {
    const out = patchSandbox(parsed, { 'ZombieLore.Speed': 3 });
    const after = parseSandbox(out);
    expect(after.values['ZombieLore.Speed']).toBe(3);
    for (const [k, v] of Object.entries(parsed.values)) {
      if (k === 'ZombieLore.Speed') continue;
      expect(after.values[k], `${k} must be unchanged`).toStrictEqual(v);
    }
  });

  it('preserves comments, unknown vanilla options and mod sections', () => {
    const out = patchSandbox(parsed, { 'MultiplierConfig.Global': 2.5 });
    expect(out).toContain('-- A hypothetical FUTURE vanilla option ZPanel has no schema for.');
    expect(out).toMatch(/SomeFuturePZOption = 42/);
    expect(out).toMatch(/SomeMod = \{/);
    expect(out).toMatch(/Deep = 1\.5/);
    expect(out).toMatch(/MultiplierConfig = \{/);
    // PZ's own legend comments survive
    expect(out).toContain('-- 1 = Sprinters');
    const before = (FIXTURE.match(/^\s*--/gm) || []).length;
    const afterCount = (out.match(/^\s*--/gm) || []).length;
    expect(afterCount).toBe(before);
  });

  it('round-trips: parse -> modify -> write -> parse keeps the whole document stable', () => {
    const out = patchSandbox(parsed, { Zombies: 2, 'Map.AllowMiniMap': true, FoodLootNew: 1.25 });
    const after = parseSandbox(out);
    expect(after.values['Zombies']).toBe(2);
    expect(after.values['Map.AllowMiniMap']).toBe(true);
    expect(after.values['FoodLootNew']).toBeCloseTo(1.25);
    expect(Object.keys(after.values).sort()).toEqual(Object.keys(parsed.values).sort());
    // A second identical patch is a no-op on the text.
    expect(patchSandbox(after, { Zombies: 2 })).toBe(out);
  });

  it('preserves Lua types on write (no "true", no stringified numbers, floats stay floats)', () => {
    const out = patchSandbox(parsed, {
      ZombieVoronoiNoise: false,
      'MultiplierConfig.Fitness': 2,
      LootItemRemovalList: 'Base.Hat',
      Zombies: 3,
    });
    expect(out).toMatch(/ZombieVoronoiNoise = false,/); // bare bool, not "false"
    expect(out).toMatch(/Fitness = 2\.0,/); // float field keeps float spelling
    expect(out).toMatch(/LootItemRemovalList = "Base\.Hat",/); // quoted string
    expect(out).toMatch(/\n\s*Zombies = 3,/); // int stays bare
  });

  it('an empty string round-trips as an empty string (never null)', () => {
    const out = patchSandbox(parsed, { WorldItemRemovalList: '' });
    expect(parseSandbox(out).values['WorldItemRemovalList']).toBe('');
    expect(out).toMatch(/WorldItemRemovalList = "",/);
  });

  it('rejects patching a path that is not in the file', () => {
    expect(() => patchSandbox(parsed, { NotARealOption: 1 })).toThrow();
  });
});

// --- schema integrity --------------------------------------------------------
describe('sandbox schema integrity', () => {
  it('documents where the metadata came from', () => {
    expect(SCHEMA_SOURCE).toMatch(/SandboxVars\.lua/);
  });

  it('every path is unique', () => {
    const seen = new Set<string>();
    for (const f of SANDBOX_SCHEMA) {
      expect(seen.has(f.path), `duplicate path ${f.path}`).toBe(false);
      seen.add(f.path);
    }
  });

  it('never exposes VERSION as an editable setting', () => {
    expect(SANDBOX_SCHEMA.some((f) => f.path === 'VERSION' || f.path.endsWith('.VERSION'))).toBe(false);
  });

  it('every enum option has a non-empty label and a numeric value, unique within the field', () => {
    for (const f of SANDBOX_SCHEMA.filter((x) => x.kind === 'enum')) {
      expect(f.options, `${f.path} enum needs options`).toBeTruthy();
      const labels = new Set<string>();
      const values = new Set<number>();
      for (const o of f.options!) {
        expect(typeof o.value, `${f.path}`).toBe('number');
        expect(o.label.trim().length, `${f.path} option ${o.value} needs a label`).toBeGreaterThan(0);
        expect(labels.has(o.label), `${f.path} duplicate label ${o.label}`).toBe(false);
        expect(values.has(o.value), `${f.path} duplicate value ${o.value}`).toBe(false);
        labels.add(o.label);
        values.add(o.value);
      }
    }
  });

  it('min <= max wherever both are known', () => {
    for (const f of SANDBOX_SCHEMA) {
      if (f.min !== undefined && f.max !== undefined) {
        expect(f.min, `${f.path}`).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it('numeric defaults fall inside their own range', () => {
    for (const f of SANDBOX_SCHEMA) {
      if (typeof f.default === 'number' && f.kind !== 'enum') {
        if (f.min !== undefined) expect(f.default, `${f.path} default < min`).toBeGreaterThanOrEqual(f.min);
        if (f.max !== undefined) expect(f.default, `${f.path} default > max`).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it('enum defaults name a real option value', () => {
    for (const f of SANDBOX_SCHEMA.filter((x) => x.kind === 'enum' && x.default !== undefined)) {
      expect(f.options!.some((o) => o.value === f.default), `${f.path} default ${f.default}`).toBe(true);
    }
  });

  it('every field has a label and a category from the known set', () => {
    for (const f of SANDBOX_SCHEMA) {
      expect(f.label.trim().length, `${f.path} needs a label`).toBeGreaterThan(0);
      expect(CATEGORY_ORDER, `${f.path} category ${f.category}`).toContain(f.category);
      expect(f.section.trim().length).toBeGreaterThan(0);
    }
  });

  it('represents each field kind, including text and PZ advisories', () => {
    const kinds = new Set(SANDBOX_SCHEMA.map((f) => f.kind));
    for (const k of ['enum', 'toggle', 'int', 'float', 'text']) expect(kinds).toContain(k);
    // PZ's own "do not change this" markup is captured, not invented.
    const advised = SANDBOX_SCHEMA.filter((f) => f.advanced);
    expect(advised.length).toBeGreaterThan(0);
    expect(advised.map((f) => f.path)).toContain('RollsMultiplier');
    expect(advised.every((f) => (f.warning || '').length > 10)).toBe(true);
  });

  it('descriptions are PZ\'s own text, not filler', () => {
    const withDesc = SANDBOX_SCHEMA.filter((f) => f.desc);
    expect(withDesc.length).toBeGreaterThan(200);
    for (const f of withDesc) expect(f.desc!.toLowerCase()).not.toMatch(/^controls this option/);
    expect(SANDBOX_BY_PATH.get('ZombieLore.Speed')!.desc).toMatch(/how fast zombies move/i);
  });

  it('representative fields carry the right type and bounds', () => {
    expect(SANDBOX_BY_PATH.get('Map.AllowMiniMap')!.kind).toBe('toggle');
    expect(SANDBOX_BY_PATH.get('LootItemRemovalList')!.kind).toBe('text');
    expect(SANDBOX_BY_PATH.get('StartYear')!.kind).toBe('int');
    const noise = SANDBOX_BY_PATH.get('FirearmNoiseMultiplier')!;
    expect(noise.kind).toBe('float');
    expect(noise.min).toBeCloseTo(0.2);
    expect(noise.max).toBeCloseTo(2);
    expect(noise.default).toBeCloseTo(1);
    // A float field whose sample value is whole must still be a float.
    expect(SANDBOX_BY_PATH.get('MultiplierConfig.Global')!.kind).toBe('float');
    // Enum with non 1-based-looking legend still maps by explicit value.
    const speed = SANDBOX_BY_PATH.get('ZombieLore.Speed')!;
    expect(enumToLabel(speed.options!, 4)).toBe('Random');
    expect(labelToEnum(speed.options!, 'Sprinters')).toBe(1);
  });

  it('categorises every field explicitly (nothing silently dumped in Advanced)', () => {
    expect(SANDBOX_SCHEMA.filter((f) => f.category === 'Advanced').length).toBe(0);
    // The catch-all still exists for genuinely unknown future paths.
    expect(categoryFor('TotallyUnknownFutureOption').category).toBe('Advanced');
  });
});

// --- coverage against the real Build 42 file ---------------------------------
describe('vanilla Build 42 coverage', () => {
  /** Every editable path in the fixture, minus VERSION and the injected extras. */
  const INJECTED = ['SomeFuturePZOption', 'SomeMod.OptionA', 'SomeMod.OptionB', 'SomeMod.Nested.Deep'];
  const vanillaPaths = Object.keys(parseSandbox(FIXTURE).values).filter(
    (p) => p !== 'VERSION' && !INJECTED.includes(p),
  );

  it('exposes EVERY vanilla field present in the Build 42 reference file', () => {
    const missing = vanillaPaths.filter((p) => !SANDBOX_BY_PATH.has(p));
    expect(missing, `vanilla fields missing from the schema: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not invent fields the reference file does not contain', () => {
    const extra = SANDBOX_SCHEMA.map((f) => f.path).filter((p) => !vanillaPaths.includes(p));
    expect(extra, `schema paths absent from Build 42: ${extra.join(', ')}`).toEqual([]);
  });

  it('reports the supported vanilla field count (vastly more than the original 22)', () => {
    expect(SANDBOX_SCHEMA.length).toBe(vanillaPaths.length);
    expect(SANDBOX_SCHEMA.length).toBeGreaterThan(250);
    console.log(`Supported vanilla Sandbox fields: ${SANDBOX_SCHEMA.length}`);
  });

  it('covers the nested groups and the categories the UI advertises', () => {
    for (const prefix of ['Basement.', 'Map.', 'ZombieLore.', 'ZombieConfig.', 'MultiplierConfig.']) {
      expect(SANDBOX_SCHEMA.some((f) => f.path.startsWith(prefix)), prefix).toBe(true);
    }
    const cats = new Set(SANDBOX_SCHEMA.map((f) => f.category));
    for (const c of ['General', 'Time & World', 'Loot', 'Character', 'Vehicles', 'Animals', 'Firearms', 'Map', 'Zombie Lore', 'Advanced Zombies', 'XP Multipliers']) {
      expect(cats, `missing category ${c}`).toContain(c);
    }
  });

  it('a schema default is NEVER the live value (defaults are informational only)', () => {
    // The fixture is a real server's config: several fields deviate from PZ's
    // documented default. The schema must record the DEFAULT, not that value.
    const values = parseSandbox(FIXTURE).values;
    const deviating = SANDBOX_SCHEMA.filter(
      (f) => f.default !== undefined && values[f.path] !== undefined && values[f.path] !== f.default,
    );
    expect(deviating.length, 'fixture should deviate from defaults somewhere').toBeGreaterThan(0);
    // e.g. this server runs a 10x global XP multiplier; the default is 1.
    expect(SANDBOX_BY_PATH.get('MultiplierConfig.Global')!.default).toBeCloseTo(1);
    expect(values['MultiplierConfig.Global']).toBe(10);
  });
});
