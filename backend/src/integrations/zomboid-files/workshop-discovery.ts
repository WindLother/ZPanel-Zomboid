import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../../config/paths';
import { logger } from '../../shared/logger';
import { parseModInfo } from './mod-info';

/**
 * Resolves a Steam Workshop ID to its real Project Zomboid Mod ID(s) by reading
 * the mod.info files of the downloaded Workshop content on disk. This is the
 * authoritative source of the Workshop -> Mod relationship (a Workshop item can
 * contain several mods). It is pure filesystem I/O — no AMP, no Steam network,
 * no runtime coupling — so it works under any PZ_RUNTIME.
 *
 * If the item is not downloaded yet, discovery returns found=false with no mod
 * ids; callers fall back to manual entry rather than inventing an id.
 */

export interface WorkshopDiscovery {
  workshopId: string;
  found: boolean;
  modIds: string[];
  name: string | null;
  author: string | null;
  source: 'workshop-content' | 'zomboid-workshop' | 'none';
}

const MAX_DEPTH = 5;

/** The candidate on-disk roots for a given (already-validated) workshop id. */
function candidateRoots(workshopId: string): Array<{ dir: string; source: WorkshopDiscovery['source'] }> {
  return [
    { dir: path.join(paths.workshopContentDir, workshopId), source: 'workshop-content' },
    { dir: path.join(paths.zomboidWorkshopDir, workshopId), source: 'zomboid-workshop' },
  ];
}

async function findModInfoFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.toLowerCase() === 'mod.info') out.push(full);
    else if (e.isDirectory() && !e.name.startsWith('.')) out.push(...(await findModInfoFiles(full, depth + 1)));
  }
  return out;
}

export async function discoverWorkshopMods(workshopId: string): Promise<WorkshopDiscovery> {
  for (const { dir, source } of candidateRoots(workshopId)) {
    if (!fs.existsSync(dir)) continue;
    const files = await findModInfoFiles(dir);
    if (files.length === 0) continue;

    const modIds: string[] = [];
    let name: string | null = null;
    let author: string | null = null;
    for (const file of files.sort()) {
      try {
        const info = parseModInfo(await fsp.readFile(file, 'utf8'));
        if (info.id && !modIds.includes(info.id)) modIds.push(info.id);
        if (!name && info.name) name = info.name;
        if (!author && info.author) author = info.author;
      } catch (e) {
        logger.debug({ file, err: (e as Error).message }, 'mod.info read failed');
      }
    }
    return { workshopId, found: true, modIds, name, author, source };
  }
  return { workshopId, found: false, modIds: [], name: null, author: null, source: 'none' };
}
