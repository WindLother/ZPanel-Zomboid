import { env } from '../../config/env';
import { logger } from '../../shared/logger';

/**
 * Steam Workshop published-file lookup.
 *
 * Project Zomboid's `checkModsNeedUpdate` answers yes/no for the whole
 * collection and never names an item, and Steam's local install manifest only
 * knows what is ON DISK. Neither can say whether a newer version exists.
 *
 * `ISteamRemoteStorage/GetPublishedFileDetails` is Steam's public, key-less
 * endpoint returning each item's published `time_updated`. Comparing that with
 * the locally installed `timeupdated` is what lets the panel name exactly which
 * mods are out of date, and show both versions.
 *
 * Rules:
 *  - OPTIONAL and non-fatal. If the host has no outbound network, or Steam is
 *    down, this returns what it could fetch and the caller degrades to the
 *    local-only view. It must never make the update check fail or hang.
 *  - The only data sent is public Workshop IDs already present in the server's
 *    own config. Operators who want no outbound traffic set
 *    STEAM_WORKSHOP_API=false.
 *  - Read-only. This never publishes, subscribes or downloads anything.
 */

const ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
/** Steam accepts large batches; keep requests modest and predictable. */
const BATCH = 50;

export interface WorkshopPublishedDetail {
  workshopId: string;
  title: string | null;
  /** Unix seconds when the author last updated the item on the Workshop. */
  timeUpdated: number | null;
  /** false when Steam has no such item (deleted/private/bad id). */
  found: boolean;
}

async function fetchBatch(ids: string[], timeoutMs: number): Promise<WorkshopPublishedDetail[]> {
  const body = new URLSearchParams();
  body.set('itemcount', String(ids.length));
  ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      response?: { publishedfiledetails?: Array<{ publishedfileid?: string; title?: string; time_updated?: number; result?: number }> };
    };
    const details = json.response?.publishedfiledetails ?? [];
    return details.map((d) => ({
      workshopId: String(d.publishedfileid ?? ''),
      title: d.title || null,
      timeUpdated: typeof d.time_updated === 'number' && d.time_updated > 0 ? d.time_updated : null,
      found: d.result === 1,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Published details for the given Workshop IDs, keyed by id. Missing entries
 * mean "could not determine" — never "up to date".
 */
export async function fetchPublishedDetails(
  ids: string[],
  timeoutMs = 6000,
): Promise<Map<string, WorkshopPublishedDetail>> {
  const out = new Map<string, WorkshopPublishedDetail>();
  if (!env.STEAM_WORKSHOP_API || ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      for (const d of await fetchBatch(chunk, timeoutMs)) {
        if (d.workshopId) out.set(d.workshopId, d);
      }
    } catch (e) {
      // Offline / blocked / rate-limited: degrade to the local-only view.
      logger.debug({ err: (e as Error).message, count: chunk.length }, 'Steam Workshop lookup unavailable');
      break;
    }
  }
  return out;
}
