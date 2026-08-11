# Security

## Authentication

- Server-side sessions stored in the panel database; the session id lives in a
  **signed** cookie (`zpanel_sid`) that is `HttpOnly`, `SameSite=Strict`, and
  `Secure` when `COOKIE_SECURE=true` (production behind HTTPS).
- Passwords hashed with **Argon2id** (`argon2` lib). Plaintext is never stored or
  logged. Login does constant-ish work on unknown users to blunt enumeration.
- Sessions expire after 12h; expired sessions are cleaned up on a timer.

## Authorization (server-side)

Roles: `admin` > `moderator` > `readonly`. Enforced on every route via
`requireAuth` / `requireRole(min)` — hidden frontend buttons are never trusted.

- **admin** — lifecycle, settings, sandbox, mods, whitelist, player powers/items,
  access levels, console, system health.
- **moderator** — players (kick/ban), broadcast, save, console, limited admin tools.
- **readonly** — dashboard/players/logs/activity reads.

## CSRF & origin

- Cookie auth ⇒ CSRF protection. Every state-changing `/api` request must carry
  `x-csrf-token` matching the per-session secret (`/api/auth/me` and the login
  response expose it to the SPA).
- The `Origin`/`Referer` of unsafe requests must be in `PANEL_ORIGINS`.
- CORS is restricted to `PANEL_ORIGINS` with credentials — never `*`.

## Input validation & injection resistance

- All payloads validated with zod.
- **No generic shell endpoint. No generic raw-RCON endpoint.** Dedicated UI actions
  map to dedicated backend methods.
- RCON commands are built only from typed allowlisted templates; interpolated
  arguments reject quotes, backslashes, and control characters (PZ has no escaping,
  so we reject rather than escape).
- The console enforces a command-name allowlist and a safe-character check; `quit`
  and other destructive commands are excluded (lifecycle has dedicated endpoints).
- Admin tools resolve through a fixed registry — the browser sends an action id,
  never a command.
- Access levels, item ids, vehicle scripts, perks, steam ids, and counts each have
  a strict schema.

## Secrets

- RCON password, AMP credentials, and session secret come from env only.
- Secret settings (`Password`, `RCONPassword`) are never returned to the browser —
  the API sends `{ configured: boolean }` and a blank value. A masked/blank value
  submitted back is treated as "unchanged" and never written to disk.
- The logger redacts password/token/cookie fields defensively.

## Filesystem / path traversal

- No API parameter ever becomes a path. All PZ paths derive from `config/paths.ts`
  (from env), so values like `../../etc/passwd` cannot influence reads or writes.
- Static frontend serving (when enabled) is confined to `FRONTEND_DIR`;
  path-traversal attempts return 404.

## Rate limiting & operation locking

- Global rate limit (240/min) plus a stricter login limit (8/min). Tighten
  per-route limits as needed.
- Lifecycle and config-write operations are serialized by an operation lock;
  incompatible concurrent attempts return `409 OPERATION_IN_PROGRESS`.

## Least privilege

The backend must not run as root. It needs only: read/write to the PZ `Server/`
directory and `Logs/`, read-only to `db/servertest.db`, localhost RCON, the AMP API
(or `sudo -n -u amp ampinstmgr`), and its own database. See
[DEPLOYMENT.md](DEPLOYMENT.md).
