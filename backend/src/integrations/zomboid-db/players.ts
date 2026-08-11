import fs from 'node:fs';
import Database from 'better-sqlite3';
import { paths } from '../../config/paths';
import { logger } from '../../shared/logger';

/**
 * READ-ONLY access to Project Zomboid's own account database
 * (`db/servertest.db`). This is the source of truth for offline players, the
 * whitelist, the SteamID allow-list, and bans. We open it read-only and never
 * mutate it — all mutations go through official RCON commands, which update this
 * database themselves.
 *
 * Build 42 stores access level as a `role` (role table id -> name):
 *   1 banned, 2 user, 3 priority, 4 observer, 5 gm, 6 moderator, 7 admin
 */

export interface DbAccount {
  username: string;
  steamId: string | null;
  displayName: string | null;
  role: string; // raw PZ role name (e.g. "admin", "user")
  lastConnection: string | null;
}

function open(): Database.Database | null {
  if (!fs.existsSync(paths.serverDb)) {
    logger.warn({ path: paths.serverDb }, 'PZ account database not found');
    return null;
  }
  try {
    // readonly + immutable-free; fileMustExist avoids creating an empty db.
    return new Database(paths.serverDb, { readonly: true, fileMustExist: true });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'failed to open PZ account database');
    return null;
  }
}

function withDb<T>(fn: (db: Database.Database) => T, fallback: T): T {
  const db = open();
  if (!db) return fallback;
  try {
    return fn(db);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'PZ account database query failed');
    return fallback;
  } finally {
    db.close();
  }
}

function roleMap(db: Database.Database): Map<number, string> {
  const m = new Map<number, string>();
  for (const r of db.prepare('SELECT id, name FROM role').all() as Array<{ id: number; name: string }>) {
    m.set(r.id, r.name);
  }
  return m;
}

export function listAccounts(): DbAccount[] {
  return withDb((db) => {
    const roles = roleMap(db);
    const rows = db
      .prepare(
        'SELECT username, steamid, displayName, role, lastConnection FROM whitelist ORDER BY username COLLATE NOCASE',
      )
      .all() as Array<{
      username: string;
      steamid: string | null;
      displayName: string | null;
      role: number | null;
      lastConnection: string | null;
    }>;
    return rows.map((r) => ({
      username: r.username,
      steamId: r.steamid ?? null,
      displayName: r.displayName ?? null,
      role: (r.role != null && roles.get(r.role)) || 'user',
      lastConnection: r.lastConnection ?? null,
    }));
  }, []);
}

export function getAccount(username: string): DbAccount | null {
  return listAccounts().find((a) => a.username.toLowerCase() === username.toLowerCase()) ?? null;
}

/** Whitelisted usernames (excludes the special console `admin` account? no — includes all). */
export function listWhitelistUsernames(): string[] {
  return listAccounts().map((a) => a.username);
}

export function listAllowedSteamIds(): string[] {
  return withDb((db) => {
    const rows = db.prepare('SELECT steamid FROM allowedsteamid').all() as Array<{ steamid: string }>;
    return rows.map((r) => r.steamid);
  }, []);
}

export interface BanRecord {
  steamId?: string;
  ip?: string;
  username?: string;
  reason: string | null;
}

export function listBans(): BanRecord[] {
  return withDb((db) => {
    const ids = db.prepare('SELECT steamid, reason FROM bannedid').all() as Array<{
      steamid: string;
      reason: string | null;
    }>;
    const ips = db.prepare('SELECT ip, username, reason FROM bannedip').all() as Array<{
      ip: string;
      username: string | null;
      reason: string | null;
    }>;
    return [
      ...ids.map((r) => ({ steamId: r.steamid, reason: r.reason })),
      ...ips.map((r) => ({ ip: r.ip, username: r.username ?? undefined, reason: r.reason })),
    ];
  }, []);
}

export function dbAvailable(): boolean {
  return fs.existsSync(paths.serverDb);
}
