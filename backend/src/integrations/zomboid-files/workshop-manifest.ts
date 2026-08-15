import fs from 'node:fs/promises';
import { paths } from '../../config/paths';

/**
 * Reader for Steam's own Workshop install manifest
 * (`steamapps/workshop/appworkshop_<appid>.acf`).
 *
 * This is the AUTHORITATIVE answer to two questions the panel could not
 * previously answer: is a Workshop item actually downloaded, and which version
 * of it is on disk. Project Zomboid's `checkModsNeedUpdate` reports only a
 * yes/no verdict for the whole collection — it never names an item — so the
 * per-item facts have to come from Steam's records instead.
 *
 * READ-ONLY. The panel never writes this file; SteamCMD owns it.
 *
 * The format is Valve's KeyValues text:
 *
 *   "AppWorkshop"
 *   {
 *     "WorkshopItemsInstalled"
 *     {
 *       "2409333430"
 *       {
 *         "size"        "22633937"
 *         "timeupdated" "1783017543"
 *         "manifest"    "3174013978869047882"
 *       }
 *     }
 *   }
 *
 * We do a narrow, bounded scan for that one section rather than implementing a
 * general VDF parser: fewer ways to be wrong, and nothing else in the file is
 * of interest.
 */

export interface WorkshopInstallRecord {
  workshopId: string;
  /** Bytes on disk, as Steam recorded them. */
  sizeBytes: number | null;
  /** Unix seconds for the installed content version (Steam's `timeupdated`). */
  timeUpdated: number | null;
  /** Steam content manifest id — the exact installed version. */
  manifest: string | null;
}

const QUOTED = /"([^"]*)"\s*"([^"]*)"/;
const SECTION_KEY = /"([^"]+)"\s*$/;

/** Parse the `WorkshopItemsInstalled` block out of an .acf document. */
export function parseWorkshopManifest(text: string): Map<string, WorkshopInstallRecord> {
  const out = new Map<string, WorkshopInstallRecord>();
  const lines = text.split(/\r?\n/);

  // Locate "WorkshopItemsInstalled" and the brace depth it opens at.
  let i = lines.findIndex((l) => /"WorkshopItemsInstalled"/i.test(l));
  if (i === -1) return out;
  while (i < lines.length && !lines[i].includes('{')) i += 1;
  if (i >= lines.length) return out;

  let depth = 1; // we are now inside WorkshopItemsInstalled
  let current: WorkshopInstallRecord | null = null;
  let pendingId: string | null = null;

  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line === '{') {
      depth += 1;
      if (depth === 2 && pendingId) {
        current = { workshopId: pendingId, sizeBytes: null, timeUpdated: null, manifest: null };
      }
      pendingId = null;
      continue;
    }
    if (line === '}') {
      depth -= 1;
      if (depth === 1 && current) {
        out.set(current.workshopId, current);
        current = null;
      }
      if (depth === 0) break; // end of WorkshopItemsInstalled
      continue;
    }

    const kv = QUOTED.exec(line);
    if (kv && current) {
      const [, key, value] = kv;
      if (/^size$/i.test(key)) current.sizeBytes = Number.isFinite(Number(value)) ? Number(value) : null;
      else if (/^timeupdated$/i.test(key)) current.timeUpdated = Number.isFinite(Number(value)) ? Number(value) : null;
      else if (/^manifest$/i.test(key)) current.manifest = value || null;
      continue;
    }
    if (!kv) {
      // A bare `"<id>"` line introduces the next item block.
      const sm = SECTION_KEY.exec(line);
      if (sm && depth === 1) pendingId = sm[1];
    }
  }

  return out;
}

/**
 * Installed-Workshop-item records, keyed by Workshop ID. Returns an empty map
 * when the manifest is absent or unreadable — a missing manifest means "we do
 * not know", never "not installed".
 */
export async function readWorkshopManifest(): Promise<Map<string, WorkshopInstallRecord>> {
  try {
    return parseWorkshopManifest(await fs.readFile(paths.workshopManifest, 'utf8'));
  } catch {
    return new Map();
  }
}

/** True when Steam's manifest is readable at all (distinguishes unknown from empty). */
export async function workshopManifestAvailable(): Promise<boolean> {
  try {
    await fs.access(paths.workshopManifest);
    return true;
  } catch {
    return false;
  }
}
