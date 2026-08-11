import { readServerIni, writeServerIni } from '../../integrations/zomboid-files/service';
import {
  parseModsFromIni,
  buildWorkshopItems,
  type ModsRaw,
  type ResolvedWorkshopItem,
  type WorkshopItem,
} from '../../integrations/zomboid-files/mods';
import { discoverWorkshopMods } from '../../integrations/zomboid-files/workshop-discovery';
import { isValidModId } from '../../integrations/zomboid-files/mod-info';
import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { parseCheckModsAck } from '../../integrations/rcon/parsers';
import { logTailer, type LogEntry } from '../../integrations/logs/tail';
import { err } from '../../shared/errors';
import { getAssociation, setAssociation, deleteAssociation, allAssociations } from './associations';

/**
 * Mods domain service. Handles the Workshop-ID <-> Mod-ID one-to-many
 * relationship correctly and stays Project-Zomboid-centric — no AMP/runtime
 * imports here. Config writes use the existing backup + atomic patch strategy
 * and never disturb unrelated ini values.
 */

const WORKSHOP_ID_RE = /^\d{6,12}$/;

export function assertWorkshopId(id: string): string {
  if (!WORKSHOP_ID_RE.test(id)) throw err.invalid('Workshop ID must be a 6–12 digit Steam Workshop id.', { field: 'workshopId' });
  return id;
}
export function assertModId(id: string): string {
  if (!isValidModId(id)) throw err.invalid(`Invalid Mod ID "${id}". Use only letters, digits, "_", "." and "-".`, { field: 'modId' });
  return id;
}

async function readLists(): Promise<ModsRaw> {
  const { text } = await readServerIni();
  return parseModsFromIni(text);
}

async function writeLists(lists: ModsRaw): Promise<void> {
  await writeServerIni({
    WorkshopItems: lists.workshopItems.join(';'),
    Mods: lists.mods.join(';'),
  });
}

/**
 * Resolve every Workshop item's Mod IDs + metadata. Authoritative order:
 *   1. on-disk mod.info discovery (the real relationship)
 *   2. panel-recorded association (what the admin asserted at add time)
 *   3. unresolved (empty, resolved=false) — never positional guessing.
 */
async function resolveAll(raw: ModsRaw): Promise<Map<string, ResolvedWorkshopItem>> {
  const map = new Map<string, ResolvedWorkshopItem>();
  for (const workshopId of raw.workshopItems) {
    const disk = await discoverWorkshopMods(workshopId);
    if (disk.found && disk.modIds.length > 0) {
      map.set(workshopId, { modIds: disk.modIds, name: disk.name, author: disk.author, thumbnail: null, lastUpdate: null, resolved: true });
      continue;
    }
    const assoc = getAssociation(workshopId);
    if (assoc.length > 0) {
      map.set(workshopId, { modIds: assoc, name: disk.name, author: disk.author, thumbnail: null, lastUpdate: null, resolved: true });
      continue;
    }
    map.set(workshopId, { modIds: [], name: disk.name, author: disk.author, thumbnail: null, lastUpdate: null, resolved: false });
  }
  return map;
}

const EMPTY: ResolvedWorkshopItem = { modIds: [], name: null, author: null, thumbnail: null, lastUpdate: null, resolved: false };

export async function listWorkshopItems(): Promise<WorkshopItem[]> {
  const raw = await readLists();
  const resolved = await resolveAll(raw);
  return buildWorkshopItems(raw, (id) => resolved.get(id) ?? EMPTY);
}

/** Resolve a Workshop item's known Mod IDs (disk first, then association). */
async function knownModIds(workshopId: string): Promise<string[]> {
  const disk = await discoverWorkshopMods(workshopId);
  if (disk.found && disk.modIds.length > 0) return disk.modIds;
  return getAssociation(workshopId);
}

export interface LookupResult {
  workshopId: string;
  found: boolean;
  modIds: string[];
  name: string | null;
  author: string | null;
  source: string;
  metadataAvailable: boolean;
}

/** Look up a Workshop ID's real Mod IDs from downloaded content (no network). */
export async function lookupWorkshop(workshopId: string): Promise<LookupResult> {
  assertWorkshopId(workshopId);
  const disk = await discoverWorkshopMods(workshopId);
  // Also surface any previously-asserted association if disk has nothing.
  const modIds = disk.modIds.length > 0 ? disk.modIds : getAssociation(workshopId);
  return {
    workshopId,
    found: disk.found || modIds.length > 0,
    modIds,
    name: disk.name,
    author: disk.author,
    source: disk.source,
    metadataAvailable: Boolean(disk.name || disk.author),
  };
}

export interface AddResult {
  items: WorkshopItem[];
  workshopId: string;
  addedModIds: string[];
  alreadyPresentModIds: string[];
  workshopAlreadyPresent: boolean;
}

/**
 * Add a Workshop item and its selected Mod IDs. Appends the Workshop ID to
 * `WorkshopItems=` (deduped) and each Mod ID to `Mods=` (deduped), preserving
 * existing entries and order. Records the association. Adding Mod IDs to an
 * existing Workshop item updates it in place rather than duplicating.
 */
export async function addWorkshopItem(input: { workshopId: string; modIds: string[] }): Promise<AddResult> {
  const workshopId = assertWorkshopId(input.workshopId.trim());
  if (!Array.isArray(input.modIds) || input.modIds.length === 0) {
    throw err.invalid('At least one Mod ID is required.', { field: 'modIds' });
  }
  // Validate + dedupe requested mod ids (preserve order).
  const requested: string[] = [];
  for (const raw of input.modIds) {
    const id = assertModId(String(raw).trim());
    if (!requested.includes(id)) requested.push(id);
  }

  const lists = await readLists();
  const workshopAlreadyPresent = lists.workshopItems.includes(workshopId);
  if (!workshopAlreadyPresent) lists.workshopItems.push(workshopId);

  const addedModIds: string[] = [];
  const alreadyPresentModIds: string[] = [];
  for (const id of requested) {
    if (lists.mods.includes(id)) alreadyPresentModIds.push(id);
    else {
      lists.mods.push(id);
      addedModIds.push(id);
    }
  }

  await writeLists(lists);

  // Merge the association (union of prior + requested) so future removal/display
  // knows this item's mods even before content is downloaded.
  const merged = Array.from(new Set([...getAssociation(workshopId), ...requested]));
  await setAssociation(workshopId, merged);

  const resolved = await resolveAll(lists);
  return {
    items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY),
    workshopId,
    addedModIds,
    alreadyPresentModIds,
    workshopAlreadyPresent,
  };
}

/**
 * Remove a Workshop item. Removes its Workshop ID and only the Mod IDs it owns
 * that are NOT still required by another present Workshop item. If ownership
 * cannot be proven (item not downloaded and no association), only the Workshop
 * ID is removed — Mod IDs are left untouched (conservative).
 */
export async function removeWorkshopItem(workshopId: string): Promise<{ items: WorkshopItem[]; removedModIds: string[] }> {
  assertWorkshopId(workshopId);
  const lists = await readLists();

  const owned = await knownModIds(workshopId);
  // Mod IDs required by OTHER still-present workshop items.
  const otherRequired = new Set<string>();
  for (const other of lists.workshopItems) {
    if (other === workshopId) continue;
    for (const m of await knownModIds(other)) otherRequired.add(m);
  }
  const removedModIds = owned.filter((m) => !otherRequired.has(m));

  lists.workshopItems = lists.workshopItems.filter((x) => x !== workshopId);
  if (removedModIds.length > 0) lists.mods = lists.mods.filter((m) => !removedModIds.includes(m));

  await writeLists(lists);
  await deleteAssociation(workshopId);

  const resolved = await resolveAll(lists);
  return { items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY), removedModIds };
}

/**
 * Remove a single standalone Mod ID (an entry in `Mods=` owned by no Workshop
 * item). Used by the table's remove action for local mods.
 */
export async function removeStandaloneMod(modId: string): Promise<{ items: WorkshopItem[] }> {
  assertModId(modId);
  const lists = await readLists();
  lists.mods = lists.mods.filter((m) => m !== modId);
  await writeLists(lists);
  const resolved = await resolveAll(lists);
  return { items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY) };
}

/**
 * Enable/disable a Workshop item. Enable adds all its Mod IDs to `Mods=`;
 * disable removes them (the Workshop ID stays in `WorkshopItems=`, i.e. the
 * content stays downloaded). This mirrors real PZ behavior — a mod loads iff its
 * id is in `Mods=`.
 */
export async function setWorkshopEnabled(workshopId: string, enabled: boolean): Promise<{ items: WorkshopItem[] }> {
  assertWorkshopId(workshopId);
  const lists = await readLists();
  const owned = await knownModIds(workshopId);
  if (owned.length === 0) throw err.invalid('Cannot toggle: this Workshop item has no known Mod IDs yet.', { workshopId });
  if (enabled) {
    for (const m of owned) if (!lists.mods.includes(m)) lists.mods.push(m);
  } else {
    lists.mods = lists.mods.filter((m) => !owned.includes(m));
  }
  await writeLists(lists);
  const resolved = await resolveAll(lists);
  return { items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY) };
}

/** Toggle based on current enabled state. */
export async function toggleWorkshop(workshopId: string): Promise<{ items: WorkshopItem[] }> {
  const lists = await readLists();
  const owned = await knownModIds(workshopId);
  const enabled = owned.some((m) => lists.mods.includes(m));
  return setWorkshopEnabled(workshopId, !enabled);
}

/**
 * Move a Workshop item up/down in load order. Reorders `WorkshopItems=` and
 * rebuilds `Mods=` to follow that order for owned mods, with any standalone mods
 * kept (in their existing relative order) at the end. Preserves all values.
 */
export async function moveWorkshopItem(workshopId: string, dir: -1 | 1): Promise<{ items: WorkshopItem[] }> {
  assertWorkshopId(workshopId);
  const lists = await readLists();
  const i = lists.workshopItems.indexOf(workshopId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= lists.workshopItems.length) {
    const resolved = await resolveAll(lists);
    return { items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY) };
  }
  [lists.workshopItems[i], lists.workshopItems[j]] = [lists.workshopItems[j], lists.workshopItems[i]];

  // Rebuild Mods= in the new workshop order (owned mods first), standalone last.
  const owned = new Map<string, string[]>();
  const attributed = new Set<string>();
  for (const ws of lists.workshopItems) {
    const m = (await knownModIds(ws)).filter((x) => lists.mods.includes(x));
    owned.set(ws, m);
    m.forEach((x) => attributed.add(x));
  }
  const standalone = lists.mods.filter((m) => !attributed.has(m));
  const newMods: string[] = [];
  for (const ws of lists.workshopItems) for (const m of owned.get(ws) ?? []) if (!newMods.includes(m)) newMods.push(m);
  for (const m of standalone) if (!newMods.includes(m)) newMods.push(m);
  lists.mods = newMods;

  await writeLists(lists);
  const resolved = await resolveAll(lists);
  return { items: buildWorkshopItems(lists, (id) => resolved.get(id) ?? EMPTY) };
}

/** Diagnostic: which associations the panel has recorded. */
export function recordedAssociations(): Record<string, string[]> {
  return allAssociations();
}

/**
 * `checkModsNeedUpdate` acknowledges over RCON and writes the real result to the
 * DebugLog. Issue the command, watch the live log briefly, return what was seen.
 */
export async function checkModUpdates(timeoutMs = 8000): Promise<{ accepted: boolean; findings: string[]; message: string }> {
  const raw = await rcon.exec(rconCommands.checkModsNeedUpdate());
  const ack = parseCheckModsAck(raw);
  if (!ack.accepted) return { accepted: false, findings: [], message: ack.message };

  const findings = await new Promise<string[]>((resolve) => {
    const found: string[] = [];
    const onEntry = (e: LogEntry) => {
      if (/mod/i.test(e.text) && /(update|need|out.?of.?date|checkmods)/i.test(e.text)) found.push(e.text);
    };
    logTailer.on('entry', onEntry);
    setTimeout(() => {
      logTailer.off('entry', onEntry);
      resolve(found);
    }, timeoutMs);
  });

  return {
    accepted: true,
    findings,
    message: findings.length ? `${findings.length} mod update note(s) found in the log.` : 'Check requested; no update notices seen in the log window.',
  };
}
