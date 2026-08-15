/**
 * Parsers for the two things Project Zomboid writes to the DebugLog when mod
 * updates are checked. Both formats were captured from a live Build 42 server.
 *
 *   1. The command's own verdict — which names NO mod:
 *        `CheckModsNeedUpdate: Checking....`
 *        `CheckModsNeedUpdate: Mods need update.`
 *
 *   2. Steam item state, which DOES name the Workshop ID:
 *        `Workshop: DownloadPending GetItemState()=Installed|NeedsUpdate|Downloading|DownloadPending ID=3682936016.`
 *
 * (2) is the only per-item update signal PZ emits, so it is what lets the panel
 * say WHICH mod. When PZ reports a verdict without any (2) lines, that is
 * reported honestly as "PZ did not name the items" — never guessed.
 */

export type CheckVerdict = 'checking' | 'updates_available' | 'up_to_date';

export interface WorkshopItemState {
  workshopId: string;
  /** Raw Steam state flags, e.g. ['Installed', 'NeedsUpdate', 'Downloading']. */
  states: string[];
  needsUpdate: boolean;
  installed: boolean;
  downloading: boolean;
}

const VERDICT_RE = /CheckModsNeedUpdate:\s*(.+?)\s*$/i;
const ITEM_STATE_RE = /GetItemState\(\)\s*=\s*([A-Za-z|]+)[^0-9]*ID\s*=\s*(\d{6,12})/i;

/**
 * Classify a `CheckModsNeedUpdate:` line. Returns null for any other line.
 *
 * PZ says "Mods need update." for the whole collection and gives no per-mod
 * detail; anything else it reports after "Checking...." is treated as the
 * up-to-date case only when it explicitly says so.
 */
export function parseCheckModsVerdict(text: string): CheckVerdict | null {
  const m = VERDICT_RE.exec(text);
  if (!m) return null;
  const body = m[1].toLowerCase();
  if (/checking/.test(body)) return 'checking';
  if (/need.*update/.test(body)) return 'updates_available';
  if (/up.?to.?date|no .*update|nothing/.test(body)) return 'up_to_date';
  return null;
}

/** Extract the Workshop ID and Steam state flags from a `Workshop:` line. */
export function parseWorkshopItemState(text: string): WorkshopItemState | null {
  const m = ITEM_STATE_RE.exec(text);
  if (!m) return null;
  const states = m[1]
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const has = (name: string): boolean => states.some((s) => s.toLowerCase() === name.toLowerCase());
  return {
    workshopId: m[2],
    states,
    needsUpdate: has('NeedsUpdate'),
    installed: has('Installed'),
    downloading: has('Downloading') || has('DownloadPending'),
  };
}
