import { err } from '../../shared/errors';

/**
 * Access-level mapping for this exact server (Build 42). Three representations:
 *
 *   PZ DB role name   (whitelist.role -> role.name): admin, moderator, observer,
 *                     gm, priority, user, banned
 *   RCON argument     (`/setaccesslevel "u" "X"`): confirmed accepted values from
 *                     live help = Admin, Moderator, Overseer, GM, Observer
 *   Frontend label    (ACCESS_META): Admin, Moderator, Player, Observer
 *
 * We never accept an arbitrary access-level string — the requested label is
 * validated against this allowlist before a command is built.
 */

export const FRONTEND_LEVELS = ['Admin', 'Moderator', 'Player', 'Observer', 'GM', 'Overseer'] as const;
export type FrontendLevel = (typeof FRONTEND_LEVELS)[number];

// Frontend label -> exact RCON argument. "Player" clears elevated access; on
// this build that is passed as "none" (documented limitation: not shown in the
// live help's explicit list, but it is the standard demotion value and is
// strictly allow-listed here so no injection is possible).
const FRONTEND_TO_RCON: Record<FrontendLevel, string> = {
  Admin: 'Admin',
  Moderator: 'Moderator',
  Observer: 'Observer',
  GM: 'GM',
  Overseer: 'Overseer',
  Player: 'none',
};

// PZ DB role name -> frontend display label.
const ROLE_TO_FRONTEND: Record<string, FrontendLevel> = {
  admin: 'Admin',
  moderator: 'Moderator',
  observer: 'Observer',
  gm: 'GM',
  overseer: 'Overseer',
  priority: 'Player',
  user: 'Player',
  banned: 'Player',
};

export function roleToFrontendLevel(role: string | null | undefined): FrontendLevel {
  if (!role) return 'Player';
  return ROLE_TO_FRONTEND[role.toLowerCase()] ?? 'Player';
}

/** Validate a requested label and return the exact RCON argument to use. */
export function frontendLevelToRconArg(level: string): string {
  if (!(FRONTEND_LEVELS as readonly string[]).includes(level)) {
    throw err.invalid(`Unknown access level "${level}".`, { allowed: FRONTEND_LEVELS });
  }
  return FRONTEND_TO_RCON[level as FrontendLevel];
}
