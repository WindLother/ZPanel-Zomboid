import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { parsePlayers } from '../../integrations/rcon/parsers';
import { listAccounts, listBans } from '../../integrations/zomboid-db/players';
import { roleToFrontendLevel } from './access';

/**
 * Player model. Fields the real server does NOT expose are returned as `null`
 * (never fabricated). Source of truth:
 *   online          -> RCON `players`
 *   steamId, access -> PZ account DB (whitelist/role tables)
 *   displayName     -> PZ account DB (surfaced as `character`)
 *   banned          -> PZ account DB (bannedid)
 *   ping, health, hoursPlayed, profession, connectedSeconds -> UNAVAILABLE (null)
 */
export interface Player {
  username: string;
  online: boolean;
  steamId: string | null;
  accessLevel: string;
  connectedSeconds: number | null;
  ping: number | null;
  hoursPlayed: number | null;
  character: string | null;
  profession: string | null;
  health: number | null;
  banned: boolean;
  lastConnection: string | null;
}

async function onlineUsernames(): Promise<Set<string>> {
  try {
    const raw = await rcon.exec(rconCommands.players());
    return new Set(parsePlayers(raw).usernames.map((u) => u.toLowerCase()));
  } catch {
    return new Set();
  }
}

export async function listPlayers(): Promise<Player[]> {
  const [online, accounts] = await Promise.all([onlineUsernames(), Promise.resolve(listAccounts())]);
  const bannedSteamIds = new Set(listBans().map((b) => b.steamId).filter(Boolean) as string[]);

  const byName = new Map<string, Player>();
  for (const a of accounts) {
    byName.set(a.username.toLowerCase(), {
      username: a.username,
      online: online.has(a.username.toLowerCase()),
      steamId: a.steamId,
      accessLevel: roleToFrontendLevel(a.role),
      connectedSeconds: null,
      ping: null,
      hoursPlayed: null,
      character: a.displayName,
      profession: null,
      health: null,
      banned: a.role === 'banned' || (a.steamId ? bannedSteamIds.has(a.steamId) : false),
      lastConnection: a.lastConnection,
    });
  }
  // Online players with no DB account row (Open server first-time joins).
  for (const lower of online) {
    if (!byName.has(lower)) {
      byName.set(lower, {
        username: lower,
        online: true,
        steamId: null,
        accessLevel: 'Player',
        connectedSeconds: null,
        ping: null,
        hoursPlayed: null,
        character: null,
        profession: null,
        health: null,
        banned: false,
        lastConnection: null,
      });
    }
  }
  return [...byName.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
}

export async function getPlayer(username: string): Promise<Player | null> {
  const all = await listPlayers();
  return all.find((p) => p.username.toLowerCase() === username.toLowerCase()) ?? null;
}
