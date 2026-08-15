import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';
import { logger } from '../shared/logger';

/**
 * Panel-owned application database (SQLite). This is SEPARATE from Project
 * Zomboid's own database — it stores panel users, sessions, the audit log, and
 * scheduled operations. We never store panel state in the PZ database.
 */

const dbPath = path.resolve(process.cwd(), env.PANEL_DB_PATH);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'admin',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT,
  last_login   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  actor_id   INTEGER,
  actor_name TEXT NOT NULL,
  actor_role TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  details    TEXT,
  success    INTEGER NOT NULL,
  source_ip  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(timestamp DESC);

CREATE TABLE IF NOT EXISTS scheduled_ops (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  run_at     TEXT NOT NULL,
  payload    TEXT,
  actor_name TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
`);

// Idempotent migration for pre-existing databases (adds columns if missing).
const userCols = new Set(
  (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name),
);
if (!userCols.has('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if (!userCols.has('updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');

// Audit rows carry the actor's panel role so an admin reading the trail can see
// WHICH role performed a privileged mutation (e.g. a moderator saving settings).
// Nullable: rows written before this column existed simply have no role.
const auditCols = new Set(
  (db.prepare('PRAGMA table_info(audit)').all() as Array<{ name: string }>).map((c) => c.name),
);
if (!auditCols.has('actor_role')) db.exec('ALTER TABLE audit ADD COLUMN actor_role TEXT');

logger.info({ dbPath }, 'panel database ready');
