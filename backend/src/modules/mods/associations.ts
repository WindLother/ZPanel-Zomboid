import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';
import { atomicWrite } from '../../integrations/zomboid-files/backups';
import { logger } from '../../shared/logger';

/**
 * Panel-side record of Workshop-ID -> Mod-ID associations.
 *
 * Project Zomboid's servertest.ini stores `WorkshopItems=` and `Mods=` as two
 * FLAT lists with NO recorded relationship between them. The authoritative
 * source of a Workshop item's Mod IDs is the mod.info on disk (see
 * workshop-discovery). When content is not yet downloaded, this store remembers
 * the association the administrator explicitly asserted at add time so the panel
 * can group/display/remove correctly — WITHOUT inventing positional pairings.
 *
 * This is panel bookkeeping only; the ini remains the server's source of truth,
 * so it never fights AMP or any runtime. Stored as JSON in the panel data dir.
 */

const storePath = path.join(path.dirname(path.resolve(process.cwd(), env.PANEL_DB_PATH)), 'mod-associations.json');

type AssociationMap = Record<string, string[]>;

function load(): AssociationMap {
  try {
    if (!fs.existsSync(storePath)) return {};
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as AssociationMap;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'mod-associations store unreadable; starting empty');
  }
  return {};
}

async function save(map: AssociationMap): Promise<void> {
  await atomicWrite(storePath, JSON.stringify(map, null, 2) + '\n');
}

export function getAssociation(workshopId: string): string[] {
  return load()[workshopId] ?? [];
}

export function allAssociations(): AssociationMap {
  return load();
}

export async function setAssociation(workshopId: string, modIds: string[]): Promise<void> {
  const map = load();
  map[workshopId] = [...modIds];
  await save(map);
}

export async function deleteAssociation(workshopId: string): Promise<void> {
  const map = load();
  if (workshopId in map) {
    delete map[workshopId];
    await save(map);
  }
}
