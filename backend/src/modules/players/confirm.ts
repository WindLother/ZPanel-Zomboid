import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { parsePlayers } from '../../integrations/rcon/parsers';
import { getAccount, listBans } from '../../integrations/zomboid-db/players';
import { confirmWithRetry } from '../../shared/retry';
import { roleToFrontendLevel } from './access';

/**
 * Authoritative confirmation of player mutations, checked AFTER the RCON command
 * against the real state (online players via RCON, roles/bans via the read-only
 * PZ database). Bounded retries absorb the short delay before PZ flushes DB
 * changes. Returns false honestly when the effect cannot be confirmed.
 */

async function isOnline(user: string): Promise<boolean> {
  const raw = await rcon.exec(rconCommands.players());
  return parsePlayers(raw).usernames.some((u) => u.toLowerCase() === user.toLowerCase());
}

/** kick -> player is no longer present in the players list. */
export function confirmKicked(user: string): Promise<boolean> {
  return confirmWithRetry(() => isOnline(user), (online) => online === false, { attempts: 3, delayMs: 300 });
}

/** access -> the account's role, read from the DB, maps to the requested level. */
export function confirmAccessLevel(user: string, level: string): Promise<boolean> {
  return confirmWithRetry(
    () => getAccount(user),
    (acct) => acct != null && roleToFrontendLevel(acct.role) === level,
    { attempts: 5, delayMs: 300 },
  );
}

/** ban -> DB shows the account banned, or the user in the ban tables. */
export function confirmBanned(user: string): Promise<boolean> {
  const lower = user.toLowerCase();
  return confirmWithRetry(
    () => ({ acct: getAccount(user), bans: listBans() }),
    ({ acct, bans }) => {
      if (acct?.role === 'banned') return true;
      const sid = acct?.steamId ?? undefined;
      return bans.some(
        (b) => (sid && b.steamId === sid) || (b.username && b.username.toLowerCase() === lower),
      );
    },
    { attempts: 5, delayMs: 300 },
  );
}
