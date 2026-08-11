import crypto from 'node:crypto';
import argon2 from 'argon2';
import { db } from '../../db';
import { err } from '../../shared/errors';

/**
 * Authentication: Argon2id password hashing and server-side sessions stored in
 * the panel database. Plaintext passwords are never stored or logged. Sessions
 * carry a per-session CSRF secret used for double-submit CSRF protection.
 */

export type Role = 'admin' | 'moderator' | 'readonly';

/** Canonical backend role identifiers (frontend labels differ: Admin/Moderator/Read Only). */
export const ROLES: readonly Role[] = ['admin', 'moderator', 'readonly'] as const;
export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface SessionRecord {
  id: string;
  userId: number;
  csrfSecret: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const ARGON_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTS);
}

export async function createUser(username: string, password: string, role: Role = 'admin'): Promise<User> {
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(username, hash, role, now, now);
    return { id: Number(info.lastInsertRowid), username, role };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw err.conflict('A user with that name already exists.');
    throw e;
  }
}

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  active: number;
}

export async function verifyLogin(username: string, password: string): Promise<User | null> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!row) {
    // Constant-ish work to reduce user-enumeration timing differences.
    await argon2.hash(password, ARGON_OPTS).catch(() => undefined);
    return null;
  }
  const ok = await argon2.verify(row.password_hash, password).catch(() => false);
  if (!ok) return null;
  // Disabled accounts cannot log in (verify still ran, so timing is unaffected).
  if (row.active !== 1) return null;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return { id: row.id, username: row.username, role: row.role };
}

export function createSession(userId: number, ip?: string): SessionRecord {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrfSecret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    'INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, csrfSecret, new Date(now).toISOString(), new Date(expiresAt).toISOString(), ip ?? null);
  return { id, userId, csrfSecret, expiresAt };
}

export function getSession(id: string): (SessionRecord & { user: User }) | null {
  // `role` and `active` are read fresh from the users row on every request, so a
  // role change or disable takes effect immediately — a session never carries a
  // cached/stale capability.
  const row = db
    .prepare(
      `SELECT s.id, s.user_id AS userId, s.csrf_secret AS csrfSecret, s.expires_at AS expiresAt,
              u.username, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as
    | { id: string; userId: number; csrfSecret: string; expiresAt: string; username: string; role: Role; active: number }
    | undefined;
  if (!row) return null;
  const expiresAt = new Date(row.expiresAt).getTime();
  if (expiresAt < Date.now() || row.active !== 1) {
    // Expired or the account was disabled -> drop the session.
    destroySession(id);
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    csrfSecret: row.csrfSecret,
    expiresAt,
    user: { id: row.userId, username: row.username, role: row.role },
  };
}

export function destroySession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Invalidate all sessions for a user (optionally keeping one, e.g. the caller's). */
export function destroyUserSessions(userId: number, exceptSessionId?: string): void {
  if (exceptSessionId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptSessionId);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function cleanupSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

export const SESSION_COOKIE = 'zpanel_sid';
export const sessionTtlMs = SESSION_TTL_MS;
