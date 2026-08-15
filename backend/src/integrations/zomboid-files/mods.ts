import { parseIni } from './ini';

/**
 * Mod configuration in `servertest.ini`:
 *   WorkshopItems=<workshopId>;<workshopId>;...   (Steam Workshop items to download)
 *   Mods=<modId>;<modId>;...                       (Mod IDs actually loaded, in order)
 *
 * A Workshop ID is NOT a Mod ID, and a Workshop item may provide SEVERAL Mod IDs.
 * PZ stores these as two flat lists with no recorded relationship, so we model
 * WorkshopItems as first-class entities and resolve their Mod IDs from an
 * injected resolver (disk mod.info discovery, then panel-recorded associations)
 * — never by positional guessing.
 */

export interface ModsRaw {
  workshopItems: string[];
  mods: string[];
}

export type ModUpdateStatus = 'updated' | 'update_available' | 'unknown';

/** Metadata + Mod IDs resolved for a Workshop item (injected into the builder). */
export interface ResolvedWorkshopItem {
  modIds: string[];
  name: string | null;
  author: string | null;
  thumbnail: string | null;
  lastUpdate: string | null;
  /** true when the Mod IDs were determined from a real source (disk/associations). */
  resolved: boolean;
}

export interface WorkshopItem {
  /** null for a standalone/local Mod ID present in `Mods=` with no Workshop item. */
  workshopId: string | null;
  name: string | null;
  author: string | null;
  thumbnail: string | null;
  lastUpdate: string | null;
  /** All Mod IDs this Workshop item provides (one-to-many). */
  modIds: string[];
  /** Subset currently present in `Mods=` (i.e. actually loaded by the server). */
  enabledModIds: string[];
  /** false when the item's Mod IDs could not be determined (not downloaded yet). */
  modIdsResolved: boolean;
  enabled: boolean;
  updateStatus: ModUpdateStatus;
  loadOrder: number;
  /**
   * Steam's record of the installed content, from
   * `appworkshop_<appid>.acf`. `null` throughout means Steam has no record of
   * the item (not downloaded) or the manifest could not be read — the two are
   * distinguished by `installStateKnown`.
   */
  downloaded: boolean;
  /** ISO timestamp of the installed content version (Steam `timeupdated`). */
  installedAt: string | null;
  /** Steam content manifest id — the exact version on disk. */
  manifest: string | null;
  sizeBytes: number | null;
  /** false when Steam's manifest was unreadable, so `downloaded` is a guess-free unknown. */
  installStateKnown: boolean;
  /** ISO timestamp of the version published on the Workshop, when known. */
  latestAt: string | null;
  /** When the last update check ran; null = never checked since panel start. */
  updateCheckedAt: string | null;
}

/** Result of the most recent update check for one item. */
export interface UpdateInfo {
  updateStatus: ModUpdateStatus;
  latestAt: string | null;
  updateCheckedAt: string | null;
}

export const UNKNOWN_UPDATE: UpdateInfo = {
  updateStatus: 'unknown',
  latestAt: null,
  updateCheckedAt: null,
};

/** Per-item install facts supplied by the caller (from Steam's manifest). */
export interface InstallInfo {
  downloaded: boolean;
  installedAt: string | null;
  manifest: string | null;
  sizeBytes: number | null;
  installStateKnown: boolean;
}

export const UNKNOWN_INSTALL: InstallInfo = {
  downloaded: false,
  installedAt: null,
  manifest: null,
  sizeBytes: null,
  installStateKnown: false,
};

const splitList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

export function parseModsFromIni(iniText: string): ModsRaw {
  const { values } = parseIni(iniText);
  return {
    workshopItems: splitList(values['WorkshopItems']),
    mods: splitList(values['Mods']),
  };
}

/**
 * Build the Workshop-item-centric view from the two ini lists plus a resolver.
 * PURE and deterministic (inject `resolve`). Mods present in `Mods=` that cannot
 * be attributed to any Workshop item are surfaced as standalone entries
 * (workshopId=null) — never dropped and never positionally paired.
 */
export function buildWorkshopItems(
  raw: ModsRaw,
  resolve: (workshopId: string) => ResolvedWorkshopItem,
  installOf: (workshopId: string) => InstallInfo = () => UNKNOWN_INSTALL,
  updateOf: (workshopId: string) => UpdateInfo = () => UNKNOWN_UPDATE,
): WorkshopItem[] {
  const items: WorkshopItem[] = [];
  const attributed = new Set<string>();

  for (const workshopId of raw.workshopItems) {
    const r = resolve(workshopId);
    const modIds = r.modIds;
    const enabledModIds = modIds.filter((m) => raw.mods.includes(m));
    enabledModIds.forEach((m) => attributed.add(m));
    items.push({
      workshopId,
      name: r.name,
      author: r.author,
      thumbnail: r.thumbnail,
      lastUpdate: r.lastUpdate,
      modIds,
      enabledModIds,
      modIdsResolved: r.resolved,
      enabled: enabledModIds.length > 0,
      loadOrder: items.length + 1,
      ...installOf(workshopId),
      ...updateOf(workshopId),
    });
  }

  // Standalone / local Mod IDs: in `Mods=` but owned by no Workshop item.
  for (const modId of raw.mods) {
    if (attributed.has(modId)) continue;
    items.push({
      workshopId: null,
      name: modId,
      author: null,
      thumbnail: null,
      lastUpdate: null,
      modIds: [modId],
      enabledModIds: [modId],
      modIdsResolved: true,
      enabled: true,
      updateStatus: 'unknown',
      downloaded: true, // present locally in Mods= with no Workshop owner
      installedAt: null,
      manifest: null,
      sizeBytes: null,
      installStateKnown: true,
      latestAt: null,
      updateCheckedAt: null,
      loadOrder: items.length + 1,
    });
  }

  return items;
}
