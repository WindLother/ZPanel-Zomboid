import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS, SETTINGS_BY_KEY } from '../src/modules/settings/schema';
import { SETTINGS_SCHEMA } from '../src/modules/settings/schema.generated';
import { GROUPS, EXCLUDED_KEYS, POLICY, labelFor } from '../src/modules/settings/categories';

/**
 * The Server Settings editor covers the whole `<servername>.ini`. These guard
 * the two properties that matter for a schema that big:
 *
 *  1. COVERAGE — every key a real server writes is either editable or
 *     deliberately excluded. Silent omission is the failure mode that made the
 *     editor useless before.
 *  2. CONTAINMENT — it is still an ALLOWLIST with real validation, not an
 *     arbitrary ini editor, and it never touches the Mods page's keys.
 */

const FIXTURE = path.join(__dirname, 'fixtures/servertest.ini');
const iniKeys = fs
  .readFileSync(FIXTURE, 'utf8')
  .split(/\r?\n/)
  .map((l) => /^([A-Za-z0-9_]+)=/.exec(l.trim())?.[1])
  .filter((k): k is string => Boolean(k));

describe('coverage: the schema spans the real server ini', () => {
  it('every key in a server-generated ini is editable or explicitly excluded', () => {
    const missing = iniKeys.filter((k) => !EXCLUDED_KEYS.has(k) && !SETTINGS_BY_KEY.has(k));
    expect(missing, `unmapped ini keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('covers the whole file, not a token subset', () => {
    // The old hand-written schema exposed 17 of ~144 keys. Guard the regression.
    expect(SETTINGS.length).toBeGreaterThan(120);
  });

  it('Mods and WorkshopItems are NEVER settings keys (the Mods page owns them)', () => {
    for (const k of ['Mods', 'WorkshopItems']) {
      expect(EXCLUDED_KEYS.has(k)).toBe(true);
      expect(SETTINGS_BY_KEY.has(k)).toBe(false);
      expect(SETTINGS.some((s) => s.iniKey === k)).toBe(false);
      expect(SETTINGS_SCHEMA.some((s) => s.iniKey === k)).toBe(false);
    }
  });

  it('every field lands in a declared group and has a label', () => {
    const ids = new Set(GROUPS.map((g) => g.id));
    for (const s of SETTINGS) {
      expect(ids.has(s.group.id), `${s.iniKey} -> unknown group ${s.group.id}`).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.key).toBe(s.iniKey); // canonical key === ini key
    }
  });

  it('nothing fell through to the Advanced catch-all (every key is deliberately placed)', () => {
    const stray = SETTINGS.filter((s) => s.group.id === 'advanced').map((s) => s.iniKey);
    expect(stray, `unplaced keys: ${stray.join(', ')}`).toEqual([]);
  });

  it('legacy frontend key aliases still resolve (an old cached page cannot silently drop a field)', () => {
    expect(SETTINGS_BY_KEY.get('ServerName')?.iniKey).toBe('PublicName');
    expect(SETTINGS_BY_KEY.get('Description')?.iniKey).toBe('PublicDescription');
    expect(SETTINGS_BY_KEY.get('AutoCreateUser')?.iniKey).toBe('AutoCreateUserInWhiteList');
  });
});

describe('generated metadata comes from PZ, and carries no sample VALUES', () => {
  it('the generated file contains no value from the sample ini', () => {
    const generated = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'modules', 'settings', 'schema.generated.ts'),
      'utf8',
    );
    // Secrets and server-specific values from the fixture must never appear.
    for (const leak of ['REDACTED', 'HNRAprZCOmuKaGIh', 'Muldraugh, KY']) {
      expect(generated, `sample value leaked: ${leak}`).not.toContain(leak);
    }
  });

  it("lifts PZ's own bounds and descriptions", () => {
    const maxPlayers = SETTINGS_BY_KEY.get('MaxPlayers')!;
    expect(maxPlayers.min).toBe(1);
    expect(maxPlayers.max).toBe(100);
    expect(maxPlayers.desc).toMatch(/players/i);
  });

  it("lifts PZ's inline enum legends into select options", () => {
    const vis = SETTINGS_BY_KEY.get('MapRemotePlayerVisibility')!;
    expect(vis.type).toBe('select');
    expect(vis.options).toEqual(['Hidden', 'Friends', 'Friends and nearby players', 'Everyone']);
    // comma/dash style legend, whose first entry follows a colon
    expect(SETTINGS_BY_KEY.get('BadWordPolicy')!.options).toEqual([
      'ban',
      'kick',
      'record the violation in the database',
      'mute',
    ]);
  });

  it('derives readable labels without an override', () => {
    expect(labelFor('SafehouseAllowLoot')).toBe('Safehouse Allow Loot');
    expect(labelFor('PublicName')).toBe('Server Name'); // explicit override
  });
});

describe('containment: still an allowlist with real validation', () => {
  const toIni = (key: string, v: unknown): string => SETTINGS_BY_KEY.get(key)!.toIni(v);

  it('rejects out-of-range numbers using PZ\'s own bounds', () => {
    expect(() => toIni('MaxPlayers', 101)).toThrow();
    expect(() => toIni('MaxPlayers', 0)).toThrow();
    expect(toIni('MaxPlayers', 32)).toBe('32');
    expect(() => toIni('RCONPort', 70000)).toThrow();
  });

  it('rejects non-integers for int fields but accepts them for float fields', () => {
    expect(() => toIni('MaxPlayers', 3.5)).toThrow();
    expect(toIni('PVPMeleeDamageModifier', 1.5)).toBe('1.5');
  });

  it('rejects line breaks in text (they would smuggle in a second ini key)', () => {
    expect(() => toIni('PublicName', 'evil\nRCONPassword=hunter2')).toThrow();
    expect(() => toIni('PublicName', 'evil\r\nOpen=true')).toThrow();
    expect(toIni('PublicName', 'Z Mochileiros')).toBe('Z Mochileiros');
    // spaces and commas are legitimate
    expect(toIni('Map', 'Muldraugh, KY')).toBe('Muldraugh, KY');
  });

  it('rejects invalid enum selections and maps labels to PZ numbers', () => {
    expect(toIni('MapRemotePlayerVisibility', 'Everyone')).toBe('4');
    expect(toIni('MapRemotePlayerVisibility', 2)).toBe('2');
    expect(() => toIni('MapRemotePlayerVisibility', 'Nonsense')).toThrow();
    expect(() => toIni('MapRemotePlayerVisibility', 99)).toThrow();
  });

  it('toggles accept booleans and the two literal strings only', () => {
    expect(toIni('PVP', true)).toBe('true');
    expect(toIni('PVP', 'false')).toBe('false'); // NOT coerced to true
    expect(() => toIni('PVP', 'yes')).toThrow();
  });

  it('round-trips ini values back to display values', () => {
    expect(SETTINGS_BY_KEY.get('PVP')!.fromIni('true')).toBe(true);
    expect(SETTINGS_BY_KEY.get('MaxPlayers')!.fromIni('32')).toBe(32);
    expect(SETTINGS_BY_KEY.get('MapRemotePlayerVisibility')!.fromIni('3')).toBe('Friends and nearby players');
  });
});

describe('operational semantics are honest', () => {
  it('secrets are marked so their values never leave the backend', () => {
    for (const k of ['Password', 'RCONPassword', 'DiscordToken']) {
      expect(SETTINGS_BY_KEY.get(k)?.secret, `${k} must be secret`).toBe(true);
    }
  });

  it('every field is either live-appliable or declared restart-required', () => {
    for (const s of SETTINGS) {
      expect(Boolean(s.live) || Boolean(s.restart), `${s.iniKey} claims neither live nor restart`).toBe(true);
      expect(Boolean(s.live) && Boolean(s.restart), `${s.iniKey} claims both`).toBe(false);
    }
  });

  it('live is claimed only for keys explicitly verified in POLICY', () => {
    const live = SETTINGS.filter((s) => s.live).map((s) => s.iniKey).sort();
    const declared = Object.entries(POLICY).filter(([, p]) => p.live).map(([k]) => k).sort();
    expect(live).toEqual(declared);
  });

  it('self-locking and destructive keys carry an operator warning', () => {
    for (const k of ['RCONPort', 'RCONPassword', 'DefaultPort', 'ResetID']) {
      expect(SETTINGS_BY_KEY.get(k)?.warning, `${k} needs a warning`).toBeTruthy();
    }
  });
});

/**
 * The page must scale to the full ini: a group sidebar + search, the same shape
 * Sandbox already uses for 269 fields. Source-level assertions, matching the
 * other frontend suites (the page is a compiled DC template).
 */
describe('frontend: Server Settings renders the full schema', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'Zomboid_Server_Control.dc.html'), 'utf8');
  const page = html.slice(
    html.indexOf('<sc-if value="{{ page.settings }}">'),
    html.indexOf('<sc-if value="{{ page.sandbox }}">'),
  );

  it('has a search box and a group sidebar', () => {
    expect(page).toContain('form.onSettingsSearch');
    expect(page).toContain('<sc-for list="{{ settingsGroups }}"');
    expect(page).toContain('{{ settingsEmpty }}');
  });

  it('renders every field type the schema can emit, including select', () => {
    for (const branch of ['f.isToggle', 'f.isSelect', 'f.isNumber', 'f.isText', 'f.isTextarea']) {
      expect(page, `missing render branch for ${branch}`).toContain(branch);
    }
  });

  it('shows restart-required and operator warnings', () => {
    expect(page).toContain('REQUIRES SERVER RESTART');
    expect(page).toContain('{{ f.hasWarning }}');
    expect(page).toContain('{{ f.warning }}');
  });

  it('markup is balanced', () => {
    const count = (re: RegExp): number => (page.match(re) || []).length;
    expect(count(/<div\b/g)).toBe(count(/<\/div>/g));
    expect(count(/<sc-if\b/g)).toBe(count(/<\/sc-if>/g));
    expect(count(/<sc-for\b/g)).toBe(count(/<\/sc-for>/g));
  });

  it('saving sends ONLY the changed keys, never the whole loaded page', () => {
    const save = html.slice(html.indexOf('saveSettings = async () => {'), html.indexOf('discardSettings ='));
    expect(save).toContain('settingsApi.save(payload)');
    expect(save, 'must not post the entire settings array').not.toContain('settingsApi.save(this.state.settings)');
    expect(save).toMatch(/payload\[f\.key\] = f\.value/);
  });
});
