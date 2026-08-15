import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseCheckModsVerdict, parseWorkshopItemState } from '../src/integrations/logs/mod-updates';
import { parseWorkshopManifest } from '../src/integrations/zomboid-files/workshop-manifest';

/**
 * "Check for updates" used to report only "N mod(s) need updating" — no mod
 * name, no download state, no version. The root cause is that Project
 * Zomboid's `checkModsNeedUpdate` reports a verdict for the WHOLE collection
 * and never names an item.
 *
 * Identity therefore has to come from two other real sources:
 *   - the DebugLog's `Workshop: ... GetItemState()=... ID=<id>` lines
 *   - Steam's own `appworkshop_<appid>.acf` install manifest
 *
 * All sample strings below are verbatim shapes captured from a live Build 42
 * server, so these tests fail if PZ's format changes.
 */

describe('CheckModsNeedUpdate verdict lines (PZ names no mod here)', () => {
  it('recognises the two lines PZ actually writes', () => {
    expect(parseCheckModsVerdict('CheckModsNeedUpdate: Checking....')).toBe('checking');
    expect(parseCheckModsVerdict('CheckModsNeedUpdate: Mods need update.')).toBe('updates_available');
  });

  it('handles the full log-line prefix the tailer passes through', () => {
    const line =
      '[15-08-26 20:28:32.833] LOG  : Mod          f:1 st:3,403,623,784> CheckModsNeedUpdate: Mods need update.';
    expect(parseCheckModsVerdict(line)).toBe('updates_available');
  });

  it('recognises an up-to-date verdict', () => {
    expect(parseCheckModsVerdict('CheckModsNeedUpdate: Mods are up to date.')).toBe('up_to_date');
  });

  it('ignores unrelated lines', () => {
    expect(parseCheckModsVerdict('LOG : General > Save complete')).toBeNull();
    expect(parseCheckModsVerdict('Workshop: DownloadPending GetItemState()=Installed ID=123456789.')).toBeNull();
  });
});

describe('Workshop item-state lines (the ONLY per-mod signal PZ emits)', () => {
  it('extracts the Workshop ID and every Steam state flag', () => {
    const line =
      '[15-08-26 06:26:09.187] LOG  : General      f:0 st:3,353,080,137> ' +
      'Workshop: DownloadPending GetItemState()=Installed|NeedsUpdate|Downloading|DownloadPending ID=3682936016.';
    const r = parseWorkshopItemState(line)!;
    expect(r.workshopId).toBe('3682936016');
    expect(r.states).toEqual(['Installed', 'NeedsUpdate', 'Downloading', 'DownloadPending']);
    expect(r.needsUpdate).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.downloading).toBe(true);
  });

  it('reports needsUpdate=false when the flag is absent', () => {
    const r = parseWorkshopItemState('Workshop: DownloadPending GetItemState()=Installed|DownloadPending ID=2409333430.')!;
    expect(r.workshopId).toBe('2409333430');
    expect(r.needsUpdate).toBe(false);
    expect(r.installed).toBe(true);
  });

  it('ignores lines without an item state', () => {
    expect(parseWorkshopItemState('CheckModsNeedUpdate: Mods need update.')).toBeNull();
    expect(parseWorkshopItemState('Workshop: something else entirely')).toBeNull();
  });
});

describe("Steam's install manifest (downloaded? which version?)", () => {
  // Same KeyValues shape as the real appworkshop_108600.acf.
  const ACF = `"AppWorkshop"
{
\t"appid"\t\t"108600"
\t"SizeOnDisk"\t\t"316171158"
\t"NeedsUpdate"\t\t"0"
\t"WorkshopItemsInstalled"
\t{
\t\t"2409333430"
\t\t{
\t\t\t"size"\t\t"22633937"
\t\t\t"timeupdated"\t\t"1783017543"
\t\t\t"manifest"\t\t"3174013978869047882"
\t\t}
\t\t"2710167561"
\t\t{
\t\t\t"size"\t\t"806699"
\t\t\t"timeupdated"\t\t"1773426268"
\t\t\t"manifest"\t\t"8207156196203277880"
\t\t}
\t}
\t"WorkshopItemDetails"
\t{
\t\t"9999999999"
\t\t{
\t\t\t"manifest"\t\t"should-not-be-read"
\t\t}
\t}
}
`;

  it('parses every installed item with its version metadata', () => {
    const m = parseWorkshopManifest(ACF);
    expect([...m.keys()].sort()).toEqual(['2409333430', '2710167561']);
    const a = m.get('2409333430')!;
    expect(a.sizeBytes).toBe(22633937);
    expect(a.timeUpdated).toBe(1783017543);
    expect(a.manifest).toBe('3174013978869047882');
  });

  it('reads ONLY WorkshopItemsInstalled, not neighbouring sections', () => {
    expect(parseWorkshopManifest(ACF).has('9999999999')).toBe(false);
  });

  it('an absent item means "not downloaded"', () => {
    expect(parseWorkshopManifest(ACF).has('3682936016')).toBe(false);
  });

  it('returns empty (never throws) for a missing or malformed manifest', () => {
    expect(parseWorkshopManifest('').size).toBe(0);
    expect(parseWorkshopManifest('not a valid acf at all').size).toBe(0);
    expect(parseWorkshopManifest('"AppWorkshop"\n{\n}\n').size).toBe(0);
  });

  it('the timestamp converts to a real installed-version date', () => {
    const rec = parseWorkshopManifest(ACF).get('2409333430')!;
    expect(new Date(rec.timeUpdated! * 1000).toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('the report contract the UI depends on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'mods', 'service.ts'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'Zomboid_Server_Control.dc.html'), 'utf8');
  const apijs = fs.readFileSync(path.join(__dirname, '..', '..', 'api.js'), 'utf8');

  it('undetermined items keep needsUpdate = null rather than being guessed', () => {
    // base() seeds every item null; only a real signal overwrites it.
    expect(src).toMatch(/needsUpdate: null/);
    expect(src).toMatch(/let needsUpdate: boolean \| null = null;/);
    expect(src).toMatch(/let source: ModUpdateFinding\['source'\] = 'unknown';/);
  });

  it('Steam is the authoritative source, the game server the fallback', () => {
    // installed vs published timestamps -> definitive per-mod answer
    expect(src).toMatch(/pub\.timeUpdated \* 1000 > Date\.parse\(f\.installedAt\)/);
    expect(src).toMatch(/source = 'steam'/);
    // only consulted when Steam could not answer
    expect(src).toMatch(/\} else if \(st\) \{[\s\S]{0,160}source = 'server'/);
  });

  it('an item published but absent from disk counts as needing an update', () => {
    expect(src).toMatch(/!f\.downloaded\)[\s\S]{0,120}needsUpdate = true/);
  });

  it('the Steam lookup is optional and never fails the check', () => {
    const api = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'integrations', 'steam', 'workshop-api.ts'),
      'utf8',
    );
    expect(api).toMatch(/if \(!env\.STEAM_WORKSHOP_API/);   // operator can disable it
    expect(api).toMatch(/AbortController/);                  // bounded, cannot hang
    expect(api).toMatch(/catch \(e\)/);                     // offline degrades, never throws
    expect(api).not.toMatch(/api_key|apikey/i);              // public endpoint, no credentials
  });

  it('the report names the outdated mods in its message', () => {
    expect(src).toMatch(/names = outdated\.map/);
    expect(src).toMatch(/need updating: \$\{names\.join/);
  });

  it('says plainly when PZ reports updates but names nothing', () => {
    expect(src).toContain('does not say which');
  });

  it('api.js no longer fabricates a checked count', () => {
    expect(apijs).not.toMatch(/checked:\s*0/);
    expect(apijs).toContain('checkUpdates: () => post("/api/mods/check-updates", {})');
  });

  it('the mods table shows downloaded state and installed version', () => {
    expect(html).toContain('<span>DOWNLOADED</span>');
    expect(html).toContain('<span>INSTALLED VERSION</span>');
    expect(html).toContain('{{ m.downloadedText }}');
    expect(html).toContain('{{ m.installedText }}');
  });

  it('unknown install state renders as Unknown, never as "not downloaded"', () => {
    expect(html).toMatch(/installStateKnown === false \? \{ text: "Unknown"/);
  });

  it('the check result is presented per mod, not as a bare count', () => {
    const fn = html.slice(html.indexOf('checkMods = async'), html.indexOf('updateMods = async'));
    expect(fn).toContain('NEEDS UPDATE (');
    expect(fn).toContain('UP TO DATE (');
    expect(fn).toContain('COULD NOT DETERMINE (');
    expect(fn).toMatch(/i\.downloaded \? "downloaded" : "NOT downloaded"/);
    expect(fn).toContain('installedAt');
    // shows installed version against the published one, not just a count
    expect(fn).toMatch(/installed " \+ d\(i\.installedAt\) \+ " → workshop " \+ d\(i\.latestAt\)/);
  });
});
