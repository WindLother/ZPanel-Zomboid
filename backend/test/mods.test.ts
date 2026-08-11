import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseModInfo, isValidModId } from '../src/integrations/zomboid-files/mod-info';
import { parseModsFromIni, buildWorkshopItems, type ResolvedWorkshopItem } from '../src/integrations/zomboid-files/mods';
import { discoverWorkshopMods } from '../src/integrations/zomboid-files/workshop-discovery';
import { paths } from '../src/config/paths';
import * as svc from '../src/modules/mods/service';

const resolved = (modIds: string[], extra: Partial<ResolvedWorkshopItem> = {}): ResolvedWorkshopItem => ({
  modIds,
  name: null,
  author: null,
  thumbnail: null,
  lastUpdate: null,
  resolved: true,
  ...extra,
});
const UNRESOLVED: ResolvedWorkshopItem = { modIds: [], name: null, author: null, thumbnail: null, lastUpdate: null, resolved: false };

// --- mod.info parsing --------------------------------------------------------
describe('mod.info parser', () => {
  it('extracts the Mod ID (not the Workshop ID)', () => {
    const info = parseModInfo('name=Psychology Skill\nposter=poster.png\nid=psychology_skill\nauthor=Someone\n');
    expect(info.id).toBe('psychology_skill');
    expect(info.name).toBe('Psychology Skill');
    expect(info.author).toBe('Someone');
  });
  it('ignores blank/comment lines and missing values', () => {
    expect(parseModInfo('# comment\n\nname=X\nid=\n').id).toBeNull();
  });
  it('rejects invalid ids (injection/traversal/shell)', () => {
    for (const bad of ['a;b', 'a b', 'a/b', 'a\nb', '../evil', '..', '', 'x'.repeat(65), 'a|b', '$(x)']) {
      expect(isValidModId(bad)).toBe(false);
    }
    for (const ok of ['psychology_skill', 'CommonSense', 'Autotsar_Trailers', 'Mod.Sub-Part_2']) {
      expect(isValidModId(ok)).toBe(true);
    }
  });
});

// --- one-to-many model (pure) ------------------------------------------------
describe('buildWorkshopItems (Workshop -> Mod IDs, one-to-many)', () => {
  it('one Workshop ID -> one Mod ID', () => {
    const raw = parseModsFromIni('WorkshopItems=111\nMods=ModA\n');
    const items = buildWorkshopItems(raw, () => resolved(['ModA']));
    expect(items).toHaveLength(1);
    expect(items[0].workshopId).toBe('111');
    expect(items[0].modIds).toEqual(['ModA']);
    expect(items[0].enabled).toBe(true);
  });

  it('one Workshop ID -> multiple Mod IDs', () => {
    const raw = parseModsFromIni('WorkshopItems=111\nMods=CoreMod;VehiclePack\n');
    const items = buildWorkshopItems(raw, () => resolved(['CoreMod', 'VehiclePack', 'OptionalCompat']));
    expect(items).toHaveLength(1);
    expect(items[0].modIds).toEqual(['CoreMod', 'VehiclePack', 'OptionalCompat']);
    // Only the two present in Mods= are enabled; the optional one is not.
    expect(items[0].enabledModIds).toEqual(['CoreMod', 'VehiclePack']);
    expect(items[0].enabled).toBe(true);
  });

  it('makes NO positional 1:1 assumption for misaligned lists', () => {
    const raw = parseModsFromIni('WorkshopItems=111;222\nMods=ModA;ModB;ModC\n');
    // Resolver proves the real mapping: 111 -> [ModA], 222 -> [ModB]; ModC is orphan.
    const items = buildWorkshopItems(raw, (id) => (id === '111' ? resolved(['ModA']) : resolved(['ModB'])));
    const byWs = Object.fromEntries(items.filter((i) => i.workshopId).map((i) => [i.workshopId, i.modIds]));
    expect(byWs['111']).toEqual(['ModA']);
    expect(byWs['222']).toEqual(['ModB']);
    const standalone = items.find((i) => i.workshopId === null);
    expect(standalone?.modIds).toEqual(['ModC']); // surfaced, not positionally paired
  });

  it('surfaces unresolved items honestly (not downloaded, no association)', () => {
    const raw = parseModsFromIni('WorkshopItems=999\nMods=\n');
    const items = buildWorkshopItems(raw, () => UNRESOLVED);
    expect(items[0].modIdsResolved).toBe(false);
    expect(items[0].modIds).toEqual([]);
    expect(items[0].enabled).toBe(false);
  });
});

// --- disk discovery ----------------------------------------------------------
describe('workshop discovery (mod.info on disk)', () => {
  const wsRoot = (id: string) => path.join(paths.workshopContentDir, id, 'mods');
  const writeMod = (id: string, folder: string, modInfo: string) => {
    const dir = path.join(wsRoot(id), folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod.info'), modInfo);
  };
  beforeEach(() => {
    fs.rmSync(path.join(paths.workshopContentDir, 'disc111'), { recursive: true, force: true });
    fs.rmSync(path.join(paths.workshopContentDir, 'disc222'), { recursive: true, force: true });
  });

  it('discovers a single Mod ID from one mod.info', async () => {
    writeMod('disc111', 'PsychologySkill', 'name=Psychology Skill\nid=psychology_skill\n');
    const d = await discoverWorkshopMods('disc111');
    expect(d.found).toBe(true);
    expect(d.modIds).toEqual(['psychology_skill']);
    expect(d.name).toBe('Psychology Skill');
  });

  it('discovers multiple Mod IDs from multiple mod.info files', async () => {
    writeMod('disc222', 'A', 'name=Core\nid=CoreMod\n');
    writeMod('disc222', 'B', 'name=Vehicles\nid=VehiclePack\n');
    const d = await discoverWorkshopMods('disc222');
    expect(d.found).toBe(true);
    expect(d.modIds.sort()).toEqual(['CoreMod', 'VehiclePack']);
  });

  it('returns found=false when not downloaded (manual fallback path)', async () => {
    const d = await discoverWorkshopMods('123456789');
    expect(d.found).toBe(false);
    expect(d.modIds).toEqual([]);
  });
});

// --- service: config round-trip against a temp ini ---------------------------
describe('mods service (config write/round-trip)', () => {
  const iniPath = paths.serverIni;
  const assocPath = path.join(path.dirname(iniPath), '..', 'mod-associations.json');
  const readLists = () => parseModsFromIni(fs.readFileSync(iniPath, 'utf8'));

  beforeEach(() => {
    fs.mkdirSync(path.dirname(iniPath), { recursive: true });
    // baseline ini with UNRELATED values that must be preserved.
    fs.writeFileSync(
      iniPath,
      'PVP=true\nWorkshopItems=555000\nMods=ExistingMod\nMaxPlayers=32\n',
    );
    fs.rmSync(assocPath, { force: true });
  });

  it('adds one Workshop ID -> one Mod ID and preserves existing config', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['newmod'] });
    const lists = readLists();
    expect(lists.workshopItems).toEqual(['555000', '111222']); // existing preserved + appended
    expect(lists.mods).toEqual(['ExistingMod', 'newmod']);
    // Unrelated ini keys preserved.
    const raw = fs.readFileSync(iniPath, 'utf8');
    expect(raw).toContain('PVP=true');
    expect(raw).toContain('MaxPlayers=32');
  });

  it('adds multiple Mod IDs for one Workshop item', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['CoreMod', 'VehiclePack'] });
    expect(readLists().mods).toEqual(['ExistingMod', 'CoreMod', 'VehiclePack']);
  });

  it('does not duplicate an existing Workshop ID', async () => {
    await svc.addWorkshopItem({ workshopId: '555000', modIds: ['ExtraMod'] });
    const lists = readLists();
    expect(lists.workshopItems.filter((w) => w === '555000')).toHaveLength(1);
    expect(lists.mods).toEqual(['ExistingMod', 'ExtraMod']); // extra mod appended to existing item
  });

  it('does not duplicate an existing Mod ID', async () => {
    const r = await svc.addWorkshopItem({ workshopId: '111222', modIds: ['ExistingMod'] });
    expect(r.addedModIds).toEqual([]);
    expect(r.alreadyPresentModIds).toEqual(['ExistingMod']);
    expect(readLists().mods).toEqual(['ExistingMod']); // no duplicate
  });

  it('adds an extra Mod ID to an existing Workshop item (updates in place)', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['A'] });
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['B'] });
    const lists = readLists();
    expect(lists.workshopItems.filter((w) => w === '111222')).toHaveLength(1);
    expect(lists.mods).toEqual(['ExistingMod', 'A', 'B']);
    // association records BOTH mods for the workshop item
    const items = await svc.listWorkshopItems();
    const it = items.find((i) => i.workshopId === '111222');
    expect(it?.modIds.sort()).toEqual(['A', 'B']);
  });

  it('removal deletes only owned Mod IDs, never unrelated ones', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['ModX', 'ModY'] });
    const res = await svc.removeWorkshopItem('111222');
    expect(res.removedModIds.sort()).toEqual(['ModX', 'ModY']);
    const lists = readLists();
    expect(lists.workshopItems).toEqual(['555000']); // 111222 gone
    expect(lists.mods).toEqual(['ExistingMod']); // unrelated ExistingMod preserved
  });

  it('removal is conservative when the Mod ID is shared by another item', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['Shared'] });
    await svc.addWorkshopItem({ workshopId: '333444', modIds: ['Shared'] });
    const res = await svc.removeWorkshopItem('111222');
    expect(res.removedModIds).toEqual([]); // Shared still required by 333444
    expect(readLists().mods).toContain('Shared');
  });

  it('enable/disable toggles the item Mod IDs in Mods= (content stays)', async () => {
    await svc.addWorkshopItem({ workshopId: '111222', modIds: ['ToggleMod'] });
    await svc.toggleWorkshop('111222'); // disable
    let lists = readLists();
    expect(lists.mods).not.toContain('ToggleMod');
    expect(lists.workshopItems).toContain('111222'); // still downloaded
    await svc.toggleWorkshop('111222'); // enable
    lists = readLists();
    expect(lists.mods).toContain('ToggleMod');
  });

  it('rejects invalid Workshop ID and invalid Mod ID', async () => {
    await expect(svc.addWorkshopItem({ workshopId: 'abc', modIds: ['ok'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.addWorkshopItem({ workshopId: '111222', modIds: ['bad;id'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.addWorkshopItem({ workshopId: '111222', modIds: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('lookup returns manual-fallback shape when metadata is unavailable', async () => {
    const r = await svc.lookupWorkshop('987654321');
    expect(r.found).toBe(false);
    expect(r.modIds).toEqual([]);
    expect(r.metadataAvailable).toBe(false);
  });
});

// --- architectural: no AMP dependency in Mods core --------------------------
describe('Mods core has no AMP dependency', () => {
  it('mods files never import AMP / ampinstmgr', () => {
    const files = [
      'src/integrations/zomboid-files/mods.ts',
      'src/integrations/zomboid-files/mod-info.ts',
      'src/integrations/zomboid-files/workshop-discovery.ts',
      'src/modules/mods/service.ts',
      'src/modules/mods/associations.ts',
      'src/modules/mods/routes.ts',
    ];
    for (const f of files) {
      const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(text).not.toMatch(/integrations\/amp|ampinstmgr|InstanceStatus|integrations\/runtime/);
    }
  });
});
