# ZPanel Backend

Production backend for the **Project Zomboid** (CubeCoders **AMP**) server control
panel. It replaces the frontend's `mockApi.js` with a secure aggregation layer over
three real data sources:

```
                     BACKEND (Fastify + TypeScript)
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
        RCON          AMP           FILES + DB
   game runtime   lifecycle      servertest.ini
   players        CPU/RAM        SandboxVars.lua
   moderation     start/stop     Mods / Workshop
   save/broadcast update         Logs, servertest.db
```

The browser never talks to RCON, AMP, the filesystem, or the shell — every action
goes through this backend, which validates input, enforces authentication and
authorization, and records an audit trail.

## Source-of-truth table

Lifecycle and metrics go through a pluggable **runtime adapter** selected by
`PZ_RUNTIME` (`amp` by default, or `standalone` to run without AMP). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#runtime-abstraction-usable-with-and-without-amp).

| Feature | Source |
|---|---|
| Server lifecycle (start/stop/restart/update) | Runtime adapter — `amp` (HTTP API / `ampinstmgr`); `standalone` → not supported |
| CPU / RAM / uptime / state | Runtime adapter — AMP HTTP API, else OS `/proc` of the PZ process |
| Online players, save world, broadcast | RCON `players` / `save` / `servermsg` |
| Kick / ban / access level / powers / items / XP / vehicles | RCON (allowlisted commands) |
| Offline players, whitelist, bans | read-only SQLite `db/servertest.db` |
| SteamID allow-list | `allowedsteamid` table (read) + RCON `addsteamid`/`removesteamid` |
| Server settings | `servertest.ini` (read) — **AMP-owned** (see [docs/AMP.md](docs/AMP.md)) |
| Sandbox settings | `servertest_SandboxVars.lua` (safe direct patch) |
| Mods | `WorkshopItems=` / `Mods=` in the ini — **AMP-owned** |
| Logs | `Zomboid/Logs/*_DebugLog-server.txt` (tail + SSE) |
| Audit / users / sessions / schedules | panel SQLite database (separate from PZ) |

See [docs/DISCOVERY.md](docs/DISCOVERY.md) for exactly what was found on the real
server and how these decisions were made.

## Quick start

```bash
cd backend
cp .env.example .env          # then edit: PZ_RCON_PASSWORD, SESSION_SECRET, AMP creds
npm install
npm run seed:admin -- admin 'a-strong-password' admin   # create the first user
npm run dev                    # or: npm run build && npm start
```

Serve the frontend from the **same origin** as the backend (so the session cookie
and CSRF flow work). Two options:

- **Reverse proxy (recommended for production):** Caddy/Nginx serves the static
  panel and proxies `/api` + `/health` to this backend. See
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Single host (dev / small setups):** set `FRONTEND_DIR=/path/to/public` and the
  backend serves the panel itself. `public/` should contain `index.html`
  (the panel), `api.js`, and `support.js`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint |
| `npm test` | Run the unit test suite (no live server needed) |
| `npm run seed:admin -- <user> <pass> [role]` | Create/update a panel user |

## Configuration

All configuration is via environment variables (see `.env.example`). Highlights:

- `PZ_RUNTIME` — `amp` (default) or `standalone` (run without AMP).
- `PZ_SERVER_DIR` — the AMP instance's `.../Zomboid/Server` directory.
- `PZ_RCON_PASSWORD` — RCON password (never hard-coded; localhost only).
- `AMP_BASE_URL` / `AMP_USERNAME` / `AMP_PASSWORD` — AMP HTTP API. If omitted,
  lifecycle falls back to `ampinstmgr` and metrics to `/proc`.
- `SESSION_SECRET` — required in production (signs session cookies).
- `PANEL_ORIGINS` — allowed browser origins (CORS + CSRF origin checks).

## Documentation

- [docs/DISCOVERY.md](docs/DISCOVERY.md) — what the real AMP/PZ environment exposes.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, integrations, data flow.
- [docs/AMP.md](docs/AMP.md) — AMP integration and config ownership.
- [docs/SECURITY.md](docs/SECURITY.md) — auth, authorization, CSRF, secrets, limits.
- [docs/API.md](docs/API.md) — endpoint reference and error model.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — reverse proxy, systemd, least privilege.

## Known limitations

These are real constraints of the environment, surfaced honestly rather than faked:

- **Server settings & mods are AMP-owned.** Writing `servertest.ini` directly is
  overwritten when AMP restarts the server from its own config. Setting writes are
  applied with backup + atomic write and (for runtime-safe keys) a live
  `changeoption`, but for durability across an AMP-triggered restart the change
  must also reach AMP's config — see [docs/AMP.md](docs/AMP.md).
- **Per-player metrics** (ping, health, hours played, profession) are not exposed
  by RCON, the DB, or logs. Those fields are returned as `null`, not invented.
- **Build number** is not exposed by RCON/AMP here; `version` is `null`.
- **AMP HTTP API** requires operator-supplied credentials; without them the
  backend uses `ampinstmgr` (lifecycle) + `/proc` (metrics), which is fully
  functional on the host but cannot stream the AMP console.
