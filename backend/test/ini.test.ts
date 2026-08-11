import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseIni, patchIni } from '../src/integrations/zomboid-files/ini';

const realIni = fs.readFileSync(path.join(__dirname, 'fixtures/servertest.ini'), 'utf8');

describe('parseIni (real servertest.ini fixture)', () => {
  it('parses key/value pairs', () => {
    const { values } = parseIni(realIni);
    expect(values.PVP).toBe('true');
    expect(values.MaxPlayers).toBe('32');
    expect(values.RCONPort).toBe('27015');
    expect(values.PublicName).toBe('My PZ Server');
  });
  it('parses empty values', () => {
    const { values } = parseIni(realIni);
    expect(values.Mods).toBe('');
    expect(values.WorkshopItems).toBe('');
  });
});

describe('patchIni', () => {
  it('updates existing keys in place and preserves everything else', () => {
    const before = parseIni(realIni);
    const out = patchIni(realIni, { MaxPlayers: '48' });
    const after = parseIni(out);
    expect(after.values.MaxPlayers).toBe('48');
    // Every other key is preserved.
    expect(Object.keys(after.values).length).toBe(Object.keys(before.values).length);
    expect(after.values.PublicName).toBe(before.values.PublicName);
    expect(after.values.RCONPort).toBe(before.values.RCONPort);
  });

  it('appends unknown keys', () => {
    const out = patchIni(realIni, { BrandNewKey: 'hello' });
    expect(parseIni(out).values.BrandNewKey).toBe('hello');
  });

  it('is byte-identical for an empty patch', () => {
    expect(patchIni(realIni, {})).toBe(realIni);
  });

  it('preserves comments and blank lines', () => {
    const out = patchIni('# a comment\nPVP=true\n\nOpen=false\n', { PVP: 'false' });
    expect(out).toBe('# a comment\nPVP=false\n\nOpen=false\n');
  });
});
