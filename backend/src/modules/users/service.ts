import { db } from '../../db';
import { err } from '../../shared/errors';
import {
  ROLES,
  isRole,
  hashPassword,
  createUser,
  destroyUserSessions,
  type Role,
} from '../auth/service';

/**
 * PANEL user management — accounts that authenticate into the ZPanel web UI.
 * This is a SEPARATE security domain from Project Zomboid players/accounts:
 * nothing here touches servertest.db, the PZ whitelist, RCON, or PZ access
 * levels. Passwords stay Argon2id hashes and are never returned to the frontend.
 */

export interface PanelUser {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string | null;
  lastLoginAt: string | null;
}

// Conservative username format; uniqueness enforced by the DB.
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
// Concise, enforced password policy (kept in one place; the UI shows a matching hint).
export const PASSWORD_POLICY_TEXT = 'At least 10 characters, including a letter and a number.';

export function validateUsername(username: string): string {
  const u = username.trim();
  if (!USERNAME_RE.test(u)) {
    throw err.invalid('Username must be 3–32 chars: letters, digits, "_", "." or "-".', { field: 'username' });
  }
  return u;
}

export function validatePassword(password: string): string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    throw err.invalid(`Password too weak. ${PASSWORD_POLICY_TEXT}`, { field: 'password' });
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw err.invalid(`Password too weak. ${PASSWORD_POLICY_TEXT}`, { field: 'password' });
  }
  return password;
}

export function validateRole(role: unknown): Role {
  if (!isRole(role)) throw err.invalid(`Invalid role. Allowed: ${ROLES.join(', ')}.`, { field: 'role' });
  return role;
}

interface Row {
  id: number;
  username: string;
  role: Role;
  active: number;
  created_at: string;
  updated_at: string | null;
  last_login: string | null;
}

const SELECT = 'SELECT id, username, role, active, created_at, updated_at, last_login FROM users';

function toPanelUser(r: Row): PanelUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login,
  };
}

export function listUsers(): PanelUser[] {
  const rows = db.prepare(`${SELECT} ORDER BY username COLLATE NOCASE`).all() as Row[];
  return rows.map(toPanelUser);
}

export function getUser(id: number): PanelUser | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined;
  return row ? toPanelUser(row) : null;
}

function rawUser(id: number): Row | null {
  return (db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined) ?? null;
}

/** Number of active admins, optionally excluding one user id. */
export function countActiveAdmins(exceptId?: number): number {
  const sql =
    exceptId == null
      ? "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"
      : "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?";
  const stmt = db.prepare(sql);
  const res = (exceptId == null ? stmt.get() : stmt.get(exceptId)) as { n: number };
  return res.n;
}

/**
 * Throw if removing "admin-ness" from `target` would leave zero active admins.
 * Applies to demotion, disabling, and deletion of a currently-active admin —
 * regardless of whether the target is the caller.
 */
function assertNotLastAdmin(target: Row, action: string): void {
  if (target.role === 'admin' && target.active === 1 && countActiveAdmins(target.id) === 0) {
    throw err.conflict(`Cannot ${action}: ${target.username} is the last active admin.`);
  }
}

export interface CreateInput {
  username: string;
  password: string;
  role: unknown;
}

export async function createPanelUser(input: CreateInput): Promise<PanelUser> {
  const username = validateUsername(input.username);
  validatePassword(input.password);
  const role = validateRole(input.role);
  const created = await createUser(username, input.password, role); // hashes + enforces uniqueness
  return getUser(created.id)!;
}

export interface UpdateInput {
  role?: unknown;
  active?: boolean;
}

/**
 * Update role and/or active state. Enforces last-admin protection and
 * invalidates the target's sessions on a security-sensitive change (demotion or
 * disable) so no stale capability survives.
 */
export async function updateUser(id: number, input: UpdateInput): Promise<PanelUser> {
  const target = rawUser(id);
  if (!target) throw err.notFound('Panel user not found.');

  let invalidate = false;

  if (input.role !== undefined) {
    const role = validateRole(input.role);
    if (role !== target.role) {
      if (target.role === 'admin' && role !== 'admin') assertNotLastAdmin(target, 'demote');
      db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, new Date().toISOString(), id);
      invalidate = true; // role change is security-sensitive
    }
  }

  if (input.active !== undefined) {
    const next = input.active ? 1 : 0;
    if (next !== target.active) {
      if (next === 0) assertNotLastAdmin(rawUser(id)!, 'disable');
      db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?').run(next, new Date().toISOString(), id);
      if (next === 0) invalidate = true; // disabling invalidates sessions
    }
  }

  if (invalidate) destroyUserSessions(id);
  return getUser(id)!;
}

/**
 * Admin sets a new password for a user. Hash immediately; invalidate sessions.
 * When a user resets their OWN password, keep the calling session and drop the
 * rest.
 */
export async function resetUserPassword(id: number, newPassword: string, keepSessionId?: string): Promise<void> {
  const target = rawUser(id);
  if (!target) throw err.notFound('Panel user not found.');
  validatePassword(newPassword);
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, new Date().toISOString(), id);
  destroyUserSessions(id, keepSessionId);
}

export async function deleteUser(id: number): Promise<void> {
  const target = rawUser(id);
  if (!target) throw err.notFound('Panel user not found.');
  assertNotLastAdmin(target, 'delete');
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade via FK
}
