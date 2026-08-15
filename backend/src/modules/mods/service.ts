import { readServerIni, writeServerIni } from '../../integrations/zomboid-files/service';
import {
  parseModsFromIni,
  buildWorkshopItems,
  type ModsRaw,
  type ResolvedWorkshopItem,
  type WorkshopItem,
  type InstallInfo,
  UNKNOWN_INSTALL,
} from '../../integrations/zomboid-files/mods';
import { discoverWorkshopMods } from '../../integrations/zomboid-files/workshop-discovery';
import {
  readWorkshopManifest,
  workshopManifestAvailable,
  type WorkshopInstallRecord,
} from '../../integrations/zomboid-files/workshop-manifest';
import { parseCheckModsVerdict, parseWorkshopItemState } from '../../integrations/logs/mod-updates';
import { fetchPublishedDetails } from '../../integrations/steam/workshop-api';
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

/** Steam's install facts per Workshop ID, or "unknown" when unreadable. */
async function installLookup(): Promise<(id: string) => InstallInfo> {
  const known = await workshopManifestAvailable();
  if (!known) return () => UNKNOWN_INSTALL;
  const manifest = await readWorkshopManifest();
  return (id: string): InstallInfo => {
    const rec: WorkshopInstallRecord | undefined = manifest.get(id);
    if (!rec) return { downloaded: false, installedAt: null, manifest: null, sizeBytes: null, installStateKnown: true };
    return {
      downloaded: true,
      installedAt: rec.timeUpdated ? new Date(rec.timeUpdated * 1000).toISOString() : null,
      manifest: rec.manifest,
      sizeBytes: rec.sizeBytes,
      installStateKnown: true,
    };
  };
}

export async function listWorkshopItems(): Promise<WorkshopItem[]> {
  const raw = await readLists();
  const [resolved, installOf] = await Promise.all([resolveAll(raw), installLookup()]);
  return buildWorkshopItems(raw, (id) => resolved.get(id) ?? EMPTY, installOf);
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

export interface ModUpdateFinding {
  workshopId: string;
  name: string | null;
  modIds: string[];
  enabled: boolean;
  /** From Steam's manifest — is the content actually on disk. */
  downloaded: boolean;
  /** ISO timestamp of the installed content version. */
  installedAt: string | null;
  /** Steam content manifest id (the exact installed version). */
  manifest: string | null;
  sizeBytes: number | null;
  /**
   * true/false once determined; null when neither Steam nor the game server
   * could tell us. Never inferred from silence.
   */
  needsUpdate: boolean | null;
  /** Raw Steam state flags PZ reported for this item, if any. */
  states: string[];
  /** Workshop title as published (may differ from the on-disk mod.info name). */
  publishedTitle: string | null;
  /** ISO timestamp of the version currently published on the Workshop. */
  latestAt: string | null;
  /** Where `needsUpdate` came from, so the UI can be honest about confidence. */
  source: 'steam' | 'server' | 'unknown';
}

export interface ModUpdateReport {
  accepted: boolean;
  /** PZ's verdict for the collection as a whole. */
  verdict: 'updates_available' | 'up_to_date' | 'unknown';
  /** Workshop items the panel knows about (from WorkshopItems=). */
  checked: number;
  /** Items PZ explicitly named as needing an update. */
  outdated: number;
  /** Whether PZ named ANY individual item during the check. */
  namedByServer: boolean;
  /** How many items had installed-vs-published versions actually compared. */
  comparedWithWorkshop: number;
  items: ModUpdateFinding[];
  message: string;
  /** The raw log lines the verdict was drawn from, for transparency. */
  notes: string[];
}

/**
 * Check Workshop items for updates.
 *
 * Two sources, because neither is sufficient alone:
 *
 *   - RCON `checkModsNeedUpdate` gives a verdict for the WHOLE collection
 *     ("Mods need update.") and never names an item. On its own it can only
 *     produce the useless "N mods need updating" message.
 *   - The DebugLog's `Workshop: ... GetItemState()=...|NeedsUpdate|... ID=<id>`
 *     lines DO name the Workshop ID, so they are what identifies the mod.
 *
 * Steam's own install manifest supplies the rest — downloaded yes/no, the
 * installed content version and its timestamp — for every item, whether or not
 * PZ mentioned it.
 *
 * When PZ reports that updates exist but names nothing, that is reported as
 * exactly that. `needsUpdate` stays null for unmentioned items rather than
 * being guessed (AGENTS.md §1 rule 18).
 */
export async function checkModUpdates(timeoutMs = 8000): Promise<ModUpdateReport> {
  const items = await listWorkshopItems();
  const workshopItems = items.filter((i) => i.workshopId !== null);

  const base = (): ModUpdateFinding[] =>
    workshopItems.map((i) => ({
      workshopId: i.workshopId as string,
      name: i.name,
      modIds: i.modIds,
      enabled: i.enabled,
      downloaded: i.downloaded,
      installedAt: i.installedAt,
      manifest: i.manifest,
      sizeBytes: i.sizeBytes,
      needsUpdate: null,
      states: [],
      publishedTitle: null,
      latestAt: null,
      source: 'unknown' as const,
    }));

  const raw = await rcon.exec(rconCommands.checkModsNeedUpdate());
  const ack = parseCheckModsAck(raw);
  if (!ack.accepted) {
    return {
      accepted: false,
      verdict: 'unknown',
      checked: workshopItems.length,
      outdated: 0,
      namedByServer: false,
      comparedWithWorkshop: 0,
      items: base(),
      message: ack.message,
      notes: [],
    };
  }

  // Watch the live log for the verdict and for any per-item Steam state.
  const observed = await new Promise<{ verdict: ModUpdateReport['verdict']; states: Map<string, string[]>; notes: string[] }>(
    (resolve) => {
      const states = new Map<string, string[]>();
      const notes: string[] = [];
      let verdict: ModUpdateReport['verdict'] = 'unknown';
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        logTailer.off('entry', onEntry);
        clearTimeout(timer);
        resolve({ verdict, states, notes });
      };

      const onEntry = (e: LogEntry): void => {
        const v = parseCheckModsVerdict(e.text);
        if (v === 'updates_available' || v === 'up_to_date') {
          verdict = v;
          notes.push(e.text);
          // An "up to date" verdict is final; a "needs update" one may still be
          // followed by per-item lines, so keep listening for the full window.
          if (v === 'up_to_date') finish();
          return;
        }
        if (v === 'checking') {
          notes.push(e.text);
          return;
        }
        const item = parseWorkshopItemState(e.text);
        if (item) {
          states.set(item.workshopId, item.states);
          if (notes.length < 50) notes.push(e.text);
        }
      };

      const timer = setTimeout(finish, timeoutMs);
      logTailer.on('entry', onEntry);
    },
  );

  // Ask Steam what version is PUBLISHED for each item. Comparing that against
  // the installed `timeupdated` is the only way to name the outdated mods:
  // PZ's own verdict covers the whole collection and identifies nothing.
  const published = await fetchPublishedDetails(workshopItems.map((i) => i.workshopId as string));

  const findings = base().map((f) => {
    const st = observed.states.get(f.workshopId);
    const pub = published.get(f.workshopId);

    let needsUpdate: boolean | null = null;
    let source: ModUpdateFinding['source'] = 'unknown';

    // Steam is authoritative when we know both the installed and published
    // versions; the game server's own state is the fallback.
    if (pub?.found && pub.timeUpdated !== null && f.installedAt) {
      needsUpdate = pub.timeUpdated * 1000 > Date.parse(f.installedAt);
      source = 'steam';
    } else if (pub?.found && pub.timeUpdated !== null && !f.downloaded) {
      needsUpdate = true; // published, but nothing on disk yet
      source = 'steam';
    } else if (st) {
      needsUpdate = st.some((x) => x.toLowerCase() === 'needsupdate');
      source = 'server';
    }

    return {
      ...f,
      states: st ?? [],
      needsUpdate,
      source,
      publishedTitle: pub?.title ?? null,
      latestAt: pub?.timeUpdated ? new Date(pub.timeUpdated * 1000).toISOString() : null,
    };
  });

  const named = findings.filter((f) => f.needsUpdate !== null);
  const outdated = findings.filter((f) => f.needsUpdate === true);
  const namedByServer = named.length > 0;

  const compared = findings.filter((f) => f.source === 'steam').length;
  const names = outdated.map((f) => f.publishedTitle || f.name || f.modIds[0] || f.workshopId);

  let message: string;
  if (outdated.length > 0) {
    message = `${outdated.length} of ${workshopItems.length} Workshop item(s) need updating: ${names.join(', ')}.`;
  } else if (compared === workshopItems.length && workshopItems.length > 0) {
    message = `All ${workshopItems.length} Workshop item(s) are up to date (installed version matches the Workshop).`;
  } else if (observed.verdict === 'updates_available') {
    message =
      `Project Zomboid reports that mods need updating but does not say which — its ` +
      `checkModsNeedUpdate only returns a verdict for the whole collection. ` +
      (compared === 0
        ? `Steam could not be reached to compare versions, so only installed versions are shown below.`
        : `Comparing installed versions against the Workshop found nothing newer for the ${compared} item(s) that could be checked.`);
  } else if (observed.verdict === 'up_to_date') {
    message = `The server reports all mods are up to date.`;
  } else if (compared > 0) {
    message = `No verdict from the server, but ${compared} item(s) were compared against the Workshop and none are newer.`;
  } else {
    message =
      `No update verdict appeared in the ${Math.round(timeoutMs / 1000)}s log window and Steam could not be ` +
      `reached, so update state is unknown. Installed versions for all ${workshopItems.length} item(s) are listed below.`;
  }

  return {
    accepted: true,
    verdict: observed.verdict,
    checked: workshopItems.length,
    outdated: outdated.length,
    namedByServer,
    /** How many items had installed-vs-published versions actually compared. */
    comparedWithWorkshop: compared,
    items: findings,
    message,
    notes: observed.notes,
  };
}
