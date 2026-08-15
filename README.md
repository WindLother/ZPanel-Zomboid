# ZPanel — Project Zomboid Server Control Panel

ZPanel is a self-hosted web administration panel for **Project Zomboid dedicated
servers**. It gives operators a browser dashboard for a live PZ server — status,
players, moderation, configuration, mods, logs, and an audited console — backed
by a hardened Fastify/TypeScript API that talks to the real server through RCON,
the Project Zomboid filesystem/database, and a pluggable server-runtime adapter
(systemd, AMP, or none).

> **Engineering / AI-agent rules live in [AGENTS.md](AGENTS.md).** Read it fully
> before modifying this project. This README is for operators, installers, and
> contributors getting oriented.

---

## Features

Everything listed here is implemented and served by real data sources — the
panel never fabricates game state.

- **Dashboard** — server status, player count, CPU / memory / uptime metrics
  with a bounded history chart, and the public game address derived from the
  server's own configuration.
- **Players** — online player list, per-player detail, kick, ban/unban,
  access-level changes, powers (godmode, invisible, noclip), give item / XP /
  vehicle (admin tools with confirmation semantics).
- **Whitelist** — Project Zomboid account whitelist and allowed Steam IDs.
  Reads come from the PZ account database (the authoritative source); mutations
  go through official RCON commands and are then **confirmed** against that
  database rather than trusted blindly.
- **Server settings** — schema-driven editor covering the **whole
  `<servername>.ini`: 142 options across 16 groups** (General, Network, Access,
  Display, Chat, Voice, PvP, Safehouse, Factions, World, Vehicles, Moderation,
  Anti-Cheat, Discord, Backups, Identity), with Project Zomboid's own
  descriptions, bounds and enum legends. Searchable by label, key or
  description; validation, secret masking, patch semantics (only the keys you
  changed are written, everything else preserved), backup + atomic writes, and
  live `changeoption`/`reloadoptions` for the keys verified safe at runtime.
- **Sandbox** — near-complete vanilla **Build 42** `<servername>_SandboxVars.lua`
  editor: **269 options** across 13 categories, including the nested
  `Basement`, `Map`, `ZombieLore`, `ZombieConfig` and `MultiplierConfig` groups,
  with Project Zomboid's own descriptions, enum labels, min/max bounds and
  "not recommended" advisories. Searchable by label, key or description;
  backup + atomic writes; unknown vanilla options and mod-added sections are
  preserved untouched.
- **Mods / Steam Workshop** — manage `WorkshopItems=` and `Mods=` with a correct
  one-to-many Workshop-ID → Mod-ID model, mod.info discovery from downloaded
  Workshop content, load-order moves, enable/disable, and **update checks that
  name the mod**: every item shows whether Steam actually has it downloaded,
  the installed content version, and — when the Workshop is reachable — the
  published version it is compared against.
- **Logs** — live tail of the PZ `DebugLog-server` files streamed to the browser
  over Server-Sent Events, with level parsing.
- **Console** — RCON game console for admins, restricted to an explicit
  command allowlist (never a shell).
- **Admin tools** — one-click actions (helicopter, gunshot, horde, weather, …)
  from a fixed server-side registry; the browser can only send an action id.
- **Server lifecycle** — start / stop / restart (and update where the runtime
  supports it), including scheduled restarts with in-game warning broadcasts.
- **Panel users & roles** — `admin` / `moderator` / `readonly` web accounts with
  Argon2id password hashing, session invalidation, and last-admin protection.
  These are **panel accounts, not game accounts** (see below).
- **Activity / audit** — every mutating action is recorded (actor, action,
  target, outcome, source IP); the Activity Log view is admin-only, while
  recording covers all roles. Audit entries never contain passwords or hashes.
- **System health** — `/health` endpoint plus an admin-only integration report
  (RCON reachability, runtime capabilities, file access).

## Architecture

Current recommended standalone deployment:

```
Browser
   │  HTTPS
   ▼
Caddy (TLS, static frontend, reverse proxy)
   │  http://127.0.0.1:8095  (/api, /health)
   ▼
ZPanel backend (Fastify + TypeScript, non-root)
 ├── Panel database (SQLite: users, sessions, audit, scheduled ops)
 ├── RCON client (127.0.0.1 only)
 ├── PZ filesystem  (<name>.ini, <name>_SandboxVars.lua, Logs/, Workshop content)
 ├── PZ database    (read-only: whitelist, accounts)
 └── ServerRuntimeAdapter
      └── SystemdRuntimeAdapter ── sudo systemctl {start|stop|restart} <fixed unit>
           └── Project Zomboid dedicated server (non-root systemd service)
```

The browser never touches RCON, the filesystem, or a shell — every action goes
through the backend, which authenticates, authorizes, validates, executes, and
audits it.

**Runtime adapters.** Lifecycle and metrics go through a `ServerRuntimeAdapter`
abstraction selected by the `PZ_RUNTIME` environment variable:

```
ServerRuntimeAdapter
├── standalone  — DEFAULT: metrics-only via /proc; lifecycle managed outside the
│                 panel. Assumes nothing about the host, needs no extra config.
├── systemd     — recommended for production: controls one fixed systemd unit
└── amp         — optional: CubeCoders AMP owns lifecycle/metrics/updates
```

**ZPanel is not tied to AMP.** AMP is one optional adapter; the default runtime
assumes no control plane at all, and a misconfigured `PZ_RUNTIME` falls back to
`standalone` rather than reaching for something the host may not run. Nothing
outside `integrations/amp/` and `runtime/amp.adapter.ts` references AMP, and
`test/no-amp-coupling.test.ts` fails the build if that ever changes. If you do
not use AMP, you can ignore every `AMP_*` variable in this document.

## Technology stack

| Layer | Technology |
|---|---|
| Backend | Node.js ≥ 20, TypeScript (strict), Fastify 5 |
| Validation | Zod |
| Panel DB | SQLite via better-sqlite3 (WAL) |
| Passwords | Argon2id |
| Game integration | Source RCON protocol, PZ config files, PZ SQLite DB (read-only) |
| Frontend | Static HTML/JS (compiled template + `api.js` adapter), no build step |
| Process management | systemd |
| Reverse proxy | Caddy (any TLS-terminating proxy works) |
| Tests | Vitest |

Target OS: Linux with systemd (developed and operated on Ubuntu Server). Other
distros should work; only the systemd runtime and the deployment scripts assume
systemd.

## Project Zomboid compatibility

- **Tested against: Project Zomboid Build 42.20.2** (dedicated server, Steam
  appid 380870, public branch) — the version the reference deployment runs.
- RCON command surfaces and log formats were captured from a live Build 42
  server. Build 41 servers may largely work (the config file model is the same)
  but are **not tested** — treat 42.x as the supported line.
- This is a "tested version" statement, not a minimum or a guarantee for future
  builds: PZ updates occasionally change RCON output and config semantics.

## Installation overview

Prerequisites on a fresh Linux server:

- Linux with systemd (Ubuntu 22.04/24.04 tested)
- Node.js ≥ 20
- SteamCMD
- Project Zomboid Dedicated Server (Steam appid `380870`)
- A reverse proxy (Caddy recommended) and optionally a domain + HTTPS
- Two dedicated non-root system users (e.g. `pzserver` for the game, `zpanel`
  for the panel)

Recommended directory layout (the reference deployment):

```
/srv/project-zomboid/
├── server/      # PZ dedicated server install (SteamCMD target)
├── data/        # Zomboid data root (Server/, Logs/, db/, Saves/) — HOME of pzserver
└── steamcmd/    # SteamCMD install

/srv/zpanel/
├── backend/     # built backend (dist/ + node_modules + .env)
└── public/      # static frontend (index.html, api.js, support.js)
```

High-level steps:

1. **Install the PZ server** with SteamCMD as the `pzserver` user; run it once
   to generate `<servername>.ini`, `<servername>_SandboxVars.lua`, and
   `db/<servername>.db` under the data root.
2. **Create the PZ systemd unit** (see [systemd service](#the-project-zomboid-systemd-service))
   running the official `start-server.sh -servername <name>` as `pzserver`, with
   a graceful `ExecStop` that saves via RCON before quitting.
3. **Build and deploy the backend**: `npm ci && npm run build` in `backend/`,
   copy to `/srv/zpanel/backend`, create `.env` from `backend/.env.example`.
4. **Deploy the frontend**: copy `Zomboid_Server_Control.dc.html` to
   `/srv/zpanel/public/index.html` together with `api.js` and `support.js`.
5. **Create the panel systemd unit** (`pz-panel.service`) running
   `node dist/src/server.js` as `zpanel`, bound to `127.0.0.1`.
6. **Grant least privilege**: a sudoers rule allowing `zpanel` to run exactly
   `systemctl start|stop|restart <your-pz-unit>` and nothing else; filesystem
   ACLs giving `zpanel` read/write on the two config files and read on
   `Logs/` + `db/`.
7. **Front with Caddy**: serve `public/` statically, reverse-proxy `/api` and
   `/health` to `127.0.0.1:8095`, disable buffering for `/api/logs/stream`
   (SSE), and set `Cache-Control: no-store` on `/api/*`.
8. **Bootstrap the first admin**: `npm run seed:admin -- <username> <password>`
   (Argon2id-hashed; choose a strong unique password and store it in your
   password manager — the panel never displays it again).
9. **Lock down RCON**: bind/firewall it so it is reachable from localhost only.

## Configuration

All backend configuration is environment-based (a `.env` file next to the
backend is read at startup; real environment variables win). See
[`backend/.env.example`](backend/.env.example) for a complete annotated
template. **Never commit a real `.env`.**

| Variable | Required | Purpose | Example |
|---|---|---|---|
| `NODE_ENV` | no (default `development`) | `production` enforces `SESSION_SECRET` | `production` |
| `HOST` | no (default `127.0.0.1`) | Backend bind address — keep local behind the proxy | `127.0.0.1` |
| `PORT` | no (default `8095`) | Backend port | `8095` |
| `PANEL_ORIGINS` | yes in practice | Comma-separated allowed browser origins (CORS + CSRF origin check) | `https://panel.example.com` |
| `COOKIE_SECURE` | no (default `false`) | `true` when the panel is served over HTTPS | `true` |
| `SESSION_SECRET` | **yes in production** | 32+ byte random string signing session cookies | `<strong-secret>` |
| `PZ_RUNTIME` | no (default `standalone`) | Runtime adapter: `standalone` (assumes nothing), `systemd` (recommended), or `amp` (optional) | `systemd` |
| `SYSTEMD_UNIT` | with `systemd` runtime | Fixed PZ unit the panel controls — never request-derived | `project-zomboid-zpanel.service` |
| `PZ_SERVER_NAME` | yes | PZ config-set name (`<name>.ini`, `db/<name>.db`) | `myserver` |
| `PZ_SERVER_DIR` | yes | Directory containing `<name>.ini` / `<name>_SandboxVars.lua` | `/srv/project-zomboid/data/Zomboid/Server` |
| `PZ_ZOMBOID_DIR` | no (derived) | Zomboid data root (parent of `Server/`, `Logs/`, `db/`) | `/srv/project-zomboid/data/Zomboid` |
| `PZ_WORKSHOP_DIR` | no (derived) | Steam Workshop content dir (`.../workshop/content/108600`) when separate from the data root | `/srv/project-zomboid/server/steamapps/workshop/content/108600` |
| `PZ_INSTALL_DIR` | no (derived) | PZ server install dir holding `ProjectZomboid64.json` — used to read the configured JVM heap for the dashboard | `/srv/project-zomboid/server` |
| `PZ_RCON_HOST` | no (default `127.0.0.1`) | RCON host — keep local | `127.0.0.1` |
| `PZ_RCON_PORT` | no (default `27015`) | RCON TCP port (`RCONPort` in the ini) | `27115` |
| `PZ_RCON_PASSWORD` | yes in practice | RCON password (`RCONPassword` in the ini) | `<strong-secret>` |
| `STEAM_WORKSHOP_API` | no (default `true`) | Let "Check for updates" compare installed vs published Workshop versions via Steam's public API. `false` = fully offline | `true` |
| `PANEL_DB_PATH` | no (default `./data/panel.db`) | Panel SQLite location | `/var/lib/zpanel/panel.db` |
| `METRICS_SAMPLE_MS` | no (default `5000`) | Metrics sampling interval | `5000` |
| `METRICS_HISTORY_POINTS` | no (default `120`) | In-memory history buffer size | `120` |
| `FRONTEND_DIR` | no | If set, the backend serves the static frontend itself (single-host setups without a proxy serving statics) | `/srv/zpanel/public` |
| `AMP_BASE_URL` | amp runtime only | AMP instance web API | `http://127.0.0.1:8083` |
| `AMP_USERNAME` / `AMP_PASSWORD` | amp runtime only | AMP API credentials | `<strong-secret>` |
| `AMP_INSTANCE_NAME` / `AMP_INSTANCE_ID` | amp runtime only | Target AMP instance | `MyInstance01` |
| `AMP_SYSTEM_USER` | amp CLI fallback | System user owning AMP for `ampinstmgr` fallback | `amp` |
| `AMP_ALLOW_CLI` | no (default `true`) | Allow the `ampinstmgr` CLI fallback | `true` |

Secrets (`SESSION_SECRET`, `PZ_RCON_PASSWORD`, AMP credentials) must only ever
live in the deployed `.env` (mode `0600`) — never in Git, docs, or logs.

## Runtime modes

### `systemd` (recommended)

The panel controls one **fixed** systemd unit (`SYSTEMD_UNIT`) through a scoped
sudoers rule. Capabilities: lifecycle ✔, metrics ✔ (via `/proc`), update ✘,
durable server settings ✔. Start/stop/restart run
`sudo systemctl <verb> <unit>` with a hard-coded verb allowlist — the unit name
and verbs are server configuration, never request input. Status comes from
`systemctl is-active`; CPU/memory/uptime come from `/proc` sampling of the PZ
process (matched by server name, never "any Java process"). The dashboard's
memory limit is the real configured Java heap, read from the process command
line or the authoritative `ProjectZomboid64.json` (`PZ_INSTALL_DIR`) — shown as
unknown when neither source has it, never guessed.

### `amp` (optional)

For servers managed by CubeCoders AMP. Capabilities: lifecycle ✔, metrics ✔,
update ✔, durable server settings ✘ — AMP regenerates `<name>.ini` from its own
settings store on restart, so the panel reports ini writes as non-durable in
this mode. Uses the AMP HTTP API when credentials are configured, with an
optional `ampinstmgr` CLI fallback. **AMP is not required to run ZPanel.**

### `standalone`

For servers started by anything else (docker, a shell script, by hand).
Capabilities: lifecycle ✘ (start/stop/restart fail honestly with
`NOT_SUPPORTED`), metrics ✔ via `/proc`, durable server settings ✔. Everything
that works over RCON and files (players, whitelist, settings, mods, logs,
console) works normally.

## The Project Zomboid systemd service

The reference unit (`project-zomboid-zpanel.service`) runs the official
launcher as a dedicated non-root user:

```ini
[Service]
User=pzserver
WorkingDirectory=/srv/project-zomboid/server
Environment=HOME=/srv/project-zomboid/data
ExecStart=/srv/project-zomboid/server/start-server.sh -servername <name>
ExecStop=<graceful stop script: RCON save + quit>
TimeoutStopSec=90
```

Operator commands:

```bash
sudo systemctl status  project-zomboid-zpanel
sudo systemctl start   project-zomboid-zpanel
sudo systemctl stop    project-zomboid-zpanel
sudo systemctl restart project-zomboid-zpanel
journalctl -u project-zomboid-zpanel -e
```

**Graceful shutdown** is the only supported stop path: `ExecStop` issues an RCON
`save` then `quit`, and systemd waits (`TimeoutStopSec`) for the JVM to exit on
its own. Do not `kill -9` the server as a routine procedure — that risks world
corruption.

## The ZPanel service

`pz-panel.service` runs the web backend only, as the unprivileged `zpanel` user,
bound to `127.0.0.1:8095`:

```bash
sudo systemctl status  pz-panel
sudo systemctl restart pz-panel
journalctl -u pz-panel -e
```

Restarting the panel **never** restarts Project Zomboid — they are independent
services. The backend force-closes lingering SSE log-stream connections on
shutdown and has a bounded shutdown grace period, so a normal
`systemctl restart pz-panel` completes cleanly.

## First login & panel users

Panel authentication is completely separate from the game:

| | Panel users (**Users & Access**) | PZ players (**Whitelist**) |
|---|---|---|
| Purpose | Log in to this web panel | Connect to the game server |
| Stored in | Panel SQLite DB (Argon2id hashes) | PZ's own `db/<name>.db` |
| Managed via | `/api/users` (admin only) | `/api/whitelist` (RCON + PZ DB) |

They are **never** mixed: creating a panel user does not whitelist anyone, and
whitelisting a player creates no panel account.

Bootstrap the first admin on the server (never through an unauthenticated
endpoint):

```bash
cd /srv/zpanel/backend
npm run seed:admin -- <username> '<strong-password>'
```

Roles (checked server-side on every request; hiding a button is never the
security boundary):

| Role | Can |
|---|---|
| `admin` | Everything: full lifecycle (start/stop/restart/update), settings, sandbox, mods, whitelist mutations, player powers/items/XP, console, Users & Access, Activity Log, system health |
| `moderator` | Day-to-day moderation and configuration: kick/ban, save, broadcast, **restart (immediate or scheduled, incl. cancelling it)**, **edit Server Settings**, **edit Sandbox Settings**, **mod curation (add / remove / enable / disable / update checks)**, moderator quick-actions — no start/stop/update, no mod load-order changes, no whitelist writes, no console, no user management, no Activity Log |
| `readonly` | View the read pages (dashboard, players, whitelist, settings, sandbox, mods, logs); no mutations, no admin pages |

Configuration write access by role:

| Capability | admin | moderator | readonly |
|---|---|---|---|
| Read Server Settings / Sandbox | ✔ | ✔ | ✔ |
| Save Server Settings (`PUT /api/settings`) | ✔ | ✔ | ✘ (403) |
| Save Sandbox Settings (`PUT /api/sandbox`) | ✔ | ✔ | ✘ (403) |
| Users & Access, Activity Log, Server Console, system connections | ✔ | ✘ | ✘ |
| Start / Stop / Update, mod load-order, whitelist writes | ✔ | ✘ | ✘ |

Saving configuration is **not** lifecycle control: a save writes the file (with
backup + atomic write) and reports *Restart required* when the changed keys only
take effect at startup. It never restarts Project Zomboid, and it does not grant
a moderator any start/stop/update ability.

Canonical page access (navigation, direct-route fallback, and data loading all
follow it; the backend enforces the same matrix server-side):

| Page | admin | moderator | readonly |
|---|---|---|---|
| Dashboard, Players, Whitelist, Settings, Sandbox, Mods, Logs | ✔ | ✔ (read; mutations per role — incl. saving Settings & Sandbox) | ✔ (read-only) |
| Admin Tools | ✔ (all tools) | ✔ (moderator-level tools only) | ✘ |
| Server Console | ✔ | ✘ | ✘ |
| Users & Access | ✔ | ✘ | ✘ |
| Activity Log | ✔ | ✘ | ✘ |

Lifecycle is split by recoverability: **restart** is available to moderators
(the server comes back on its own), while **start / stop / update** stay
admin-only because they leave the server down or change installed content.

Mods are split the same way: moderators **curate** the list (add, remove,
enable/disable, check for updates), while **load-order changes** and **content
updates** remain admin-only.

Configuration editing follows the same reasoning: **Server Settings and Sandbox
Settings writes are available to moderators** — they are reviewable, backed up
before every write, and reversible — while Users & Access, the Activity Log, the
Server Console, system connections and start/stop/update remain admin-only.
Read-only accounts see both editors with the values filled in, but the controls
render disabled and the panel sends no write request; the backend independently
answers `403`.

Moderator/readonly actions are still **recorded** in the audit trail — the
admin-only restriction applies to *viewing* it, never to auditing. Each entry
carries the actor's own role, so an admin reading the log sees exactly which
role made a change (e.g. `kvr` · Moderator · *changed server settings*).

Additional protections: session cookies are signed and `HttpOnly`; role changes,
password resets, and disables immediately invalidate the target's sessions; the
last active admin cannot be demoted, disabled, or deleted; login attempts are
rate-limited per IP.

## Mods: Workshop IDs vs Mod IDs

Project Zomboid uses **two different identifier spaces**, and the config stores
them as two flat lists with no recorded relationship:

- `WorkshopItems=` — numeric **Steam Workshop IDs**: what SteamCMD downloads.
- `Mods=` — textual **Mod IDs** (from each mod's `mod.info`): what the game
  actually loads, in order.

**They are not interchangeable, and one Workshop item can contain several Mod
IDs** (e.g. a library + addon in one Workshop upload). Positional pairing of the
two lists is meaningless and ZPanel never uses it.

ZPanel's add-mod workflow:

1. Enter a Workshop ID → the backend looks it up.
2. If the Workshop content is already on disk, the real Mod IDs are
   **discovered from `mod.info`** (the authoritative source).
3. Otherwise you select/enter the Mod IDs explicitly; the panel records the
   association you asserted so it can group/display/remove correctly later.
4. The backend validates every ID and writes both lists with backup + atomic
   write, preserving unrelated ini content.

### Checking for mod updates

Project Zomboid's own `checkModsNeedUpdate` answers **yes/no for the whole
collection** — it never names an item — so on its own it can only produce a
useless "some mods need updating". ZPanel therefore combines three real
sources:

1. Steam's install manifest (`appworkshop_<appid>.acf`) — is the item actually
   **downloaded**, and which **content version** is on disk.
2. Steam's public Workshop API — the **published** version, so installed-vs-
   published tells you exactly which mods are stale (disable with
   `STEAM_WORKSHOP_API=false`).
3. The game server's own log lines (`Workshop: … GetItemState()=…|NeedsUpdate|…
   ID=<id>`) as a fallback when Steam cannot be reached.

The result names each mod with both dates, e.g. *"1 of 22 Workshop item(s) need
updating: CleanUI [B42]"* — installed 2026-08-14 → workshop 2026-08-15. An item
that no source could rule on is reported as **could not determine**, never
guessed. The Mods table keeps showing that status after the check.

**Applying updates.** Project Zomboid downloads Workshop content **itself at
startup**, so *Update Mods* does not fetch anything — a panel-side SteamCMD run
would race the process that owns the install. It lists what is pending and
offers a **restart**, which is what actually applies them. It never reports a
download that did not happen, and it tells you when no check has run yet rather
than claiming nothing is pending.

Mod IDs are validated (letters, digits, `_`, `.`, `-` only) and Workshop IDs
must be 6–12 digit numbers — semicolons, newlines, paths, and shell metacharacters
are rejected outright, since these values are written into the server's config.

## Settings & SandboxVars

- Server settings live in `<servername>.ini`; sandbox rules in
  `<servername>_SandboxVars.lua`. **These PZ files remain the source of truth**
  — ZPanel edits them in place rather than keeping a shadow copy.
- Every mutation follows the same discipline: **backup first** (panel-owned
  `.zpanel-backups/` directory, last 10 versions per file), then **atomic
  write** (temp file + fsync + rename), patching only the keys you changed.
- Secret ini values (e.g. `RCONPassword`) are never returned to the browser —
  only a "configured" flag.
- Runtime-safe ini keys are additionally applied live via RCON
  `changeoption`/`reloadoptions`; others take effect on the next restart, and
  the UI says so. A key is only reported as applied live once that has been
  verified against a real server — everything else honestly says *restart
  required* rather than claiming an effect it cannot guarantee.
- The Server Settings field list is **generated from Project Zomboid's own ini
  comments** (`backend/scripts/generate-settings-schema.ts`), the same way the
  sandbox schema is. Only metadata is taken from the sample file — never its
  values.
- `Mods=` and `WorkshopItems=` are deliberately **not** editable here; the Mods
  page owns them, so a settings save can never overwrite your mod list.
- Saving writes **only the fields you changed**. Editing the ini by hand while a
  Settings page is open is still worth avoiding — reload the page afterwards so
  it does not hold stale values for the keys you touched.
- With the `systemd`/`standalone` runtimes there is no external settings
  overlay: what's in the files is what runs. (Under AMP, AMP's own settings
  store regenerates the ini on restart — the panel surfaces this honestly via
  the `durableServerSettings` capability.)

### Sandbox coverage

The sandbox schema covers **269 vanilla Build 42 options** — every editable
field in a server-generated `SandboxVars.lua` (`VERSION` is a file marker, not a
setting) — grouped as General, Time & World, Loot, Food & Items, Nature &
Farming, Character, Vehicles, Animals, Firearms, Map, Zombie Lore, Advanced
Zombies and XP Multipliers.

Field metadata (descriptions, enum legends, `Min`/`Max`/`Default`, and PZ's own
"it is recommended that you DO NOT change this" advisories) is **generated from
Project Zomboid's own metadata comments** in a server-generated
`SandboxVars.lua` — see `backend/scripts/generate-sandbox-schema.ts`. Nothing is
scraped and no Lua is executed.

Two things worth knowing as an operator:

- A schema **default is informational**. Values shown and saved always come from
  *your* server's `SandboxVars.lua`; a field your file does not contain is
  neither displayed nor written (absence means "whatever PZ does by default").
- Saving patches **only the values you changed**, in place. Comments, formatting,
  options ZPanel does not know about, and mod-added sections all survive
  byte-for-byte. Sandbox changes are read by Project Zomboid **at startup**, so
  the panel says *restart required* rather than pretending they applied live.

## Ports

| Port | Protocol | Purpose | Exposure |
|---|---|---|---|
| Game port (`DefaultPort`) | UDP | Player connections (Steam) | Public |
| Direct/secondary port (`UDPPort`) | UDP | Second game channel | Public |
| RCON (`RCONPort`) | TCP | Remote console used by ZPanel | **LOCAL/PRIVATE ONLY** |
| HTTPS | TCP 443 | The panel, via reverse proxy | Public (authenticated) |
| Panel backend (`PORT`) | TCP | Fastify behind the proxy | Localhost only |

Example (the reference deployment): game `16361/udp`, direct `16362/udp`, RCON
`127.0.0.1:27115`, panel backend `127.0.0.1:8095` behind Caddy on 443.

**Never expose RCON publicly.** The RCON protocol is plaintext and the password
rides on it. Bind it locally and/or firewall the port so only localhost may
connect (the reference deployment adds an explicit iptables DROP for external
RCON traffic, kept persistent by a small systemd oneshot unit).

## Security model

- **Non-root everywhere**: the panel runs as `zpanel`, the game as `pzserver`.
  Neither ever runs as root.
- **RCON local-only**, password kept in the deployed `.env` (0600).
- **Sessions**: signed HttpOnly cookies; `Secure` under HTTPS; server-side
  session store with idle/absolute expiry and explicit invalidation.
- **CSRF**: state-changing requests require the `x-csrf-token` header bound to
  the session, plus an Origin/Referer allowlist check (`PANEL_ORIGINS`).
- **Passwords**: Argon2id; hashes never leave the backend; audit rows never
  contain password material.
- **Authorization is server-side**: every route declares its minimum role;
  frontend hiding is cosmetic, never the boundary.
- **Console ≠ shell**: the admin console submits to the PZ game console over
  RCON through a strict command allowlist; there is no shell execution path
  reachable from the browser.
- **Fixed systemd surface**: one unit name from config, three verbs, argv-based
  spawn (no shell interpolation), mirrored by an equally narrow sudoers rule.
- **No request-derived paths**: every file the backend touches is derived from
  server-side configuration, never from URL/body input.
- **Least-privilege filesystem**: ACLs give the panel rw on exactly the two
  config files it edits and read-only access to logs/DB/workshop content.
- **Secrets excluded from Git** (see `.gitignore`); rate limiting globally and
  stricter on login; consistent error model that never leaks stack traces.

## Backups

ZPanel automatically backs up **configuration files it is about to modify**
(`<name>.ini`, `<name>_SandboxVars.lua`) into a panel-owned
`.zpanel-backups/` directory next to them, keeping the last 10 copies per file.
Writes are atomic, so a crash mid-write never leaves a truncated config.

**This is config backup only.** ZPanel does **not** back up world saves, the PZ
database, or player data — operate your own scheduled backups (e.g. of the
Zomboid data root) for disaster recovery.

## Development

```bash
cd backend
npm install        # or: npm ci
npm run dev        # tsx watch (auto-reload) on src/server.ts
npm run lint       # eslint over src/ and test/
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # tsc -> dist/
npm start          # node dist/src/server.js
npm run seed:admin -- <user> <password> [role]
```

The frontend is static (no build step): `Zomboid_Server_Control.dc.html` is the
page (deployed as `index.html`), `api.js` is the backend adapter, `support.js`
is the template runtime. Point `FRONTEND_DIR` at a directory containing them for
a single-process dev setup.

## Deployment

```
source repo
  └─ backend: npm ci && npm run build
       └─ rsync -> /srv/zpanel/backend   (excluding .env and data/)
  └─ frontend: Zomboid_Server_Control.dc.html -> /srv/zpanel/public/index.html
               api.js, support.js        -> /srv/zpanel/public/
  └─ systemctl restart pz-panel          (backend changes only)
  └─ Caddy serves public/ + proxies /api
```

What requires which restart:

| Change | Restart |
|---|---|
| Frontend files | none (Caddy serves the new statics immediately) |
| Backend code | `pz-panel.service` only |
| `<name>.ini` / SandboxVars / mods | PZ server restart — **when you choose**, via the panel or `systemctl restart <pz-unit>` (runtime-safe ini keys apply live) |
| PZ JVM options / launcher | PZ server restart |
| Documentation | nothing |

Never restart the game server as a side effect of deploying panel code, and if
an AMP-managed server coexists on the machine, never touch it when deploying
the standalone stack.

## Troubleshooting

**Panel unreachable**
`systemctl status pz-panel caddy` · `journalctl -u pz-panel -e` ·
`curl -s http://127.0.0.1:8095/health` (expect `{"status":"ok"...}`) ·
`ss -lntp | grep 8095`.

**API returns 500s**
`journalctl -u pz-panel -e` — the response body carries a stable error `code`;
the journal has the detail. Check `.env` validity (the backend exits at boot
with a precise message on invalid config).

**RCON unavailable (503 `RCON_UNAVAILABLE`)**
Is the game up? `systemctl status <pz-unit>`. Does the ini's `RCONPort` /
`RCONPassword` match the panel's `.env`? Test locally:
`ss -lntp | grep <rcon-port>` — the port must be listening and only reachable
from localhost.

**PZ server offline / won't start**
`journalctl -u <pz-unit> -e` for JVM errors; check free memory (the JVM needs
its `-Xmx` headroom); verify the ini's ports aren't already taken by another
server (`ss -lnup`).

**Mods not loading in game**
Confirm the *Mod IDs* (not Workshop IDs) appear under `Mods=` in the ini; verify
the Workshop content actually downloaded (`PZ_WORKSHOP_DIR`); PZ needs a restart
to load new mods.

**Permission denied in panel logs**
The `zpanel` user lost read/write on a PZ path — re-check ACLs on the Server
directory and files, and that new files inherit them (default ACLs).

**systemd service failing repeatedly**
`systemctl status <unit>` + `journalctl -u <unit> --since -1h`. Fix the root
cause; avoid editing units ad-hoc — change the unit file and `daemon-reload`.

Avoid destructive shortcuts: no `kill -9`, no deleting PZ data directories, no
`chmod 777`.

## Contributing & safety

ZPanel performs **destructive administrative actions against live game
servers** — stopping servers, banning players, rewriting server configuration.
Treat every change accordingly:

- Run the full gate before deploying: `npm run lint && npm run typecheck &&
  npm test && npm run build`.
- Never point a development panel at a production server "just to test".
- Read **[AGENTS.md](AGENTS.md)** — the engineering rules, invariants, and
  security boundaries for this codebase — before modifying anything.

## License

MIT (see `backend/package.json`).
