# AGENTS.md — ZPanel

Operating manual for anyone — human developer or AI coding agent (Claude, Codex,
ChatGPT, …) — modifying this project. **Read this file fully before changing any
file.** It defines the architecture, security boundaries, invariants, operational
constraints, and the verification gate. `README.md` is the operator-facing
document; this file is the engineering contract.

- **Product:** web administration panel for Project Zomboid dedicated servers.
- **Stack:** Node.js ≥ 20 · TypeScript (strict) · Fastify 5 · SQLite
  (better-sqlite3) · Argon2id · Source RCON · systemd · static HTML/JS frontend.
- **Tested game version:** Project Zomboid Build 42.20.2 (dedicated, appid 380870).
- **This codebase controls live game servers.** A careless change can stop a
  server, corrupt a config, or ban real players.

---

## 1. Hard Rules

These are not style preferences. Breaking any of them creates a security hole,
data loss, or an outage.

1. **Never commit secrets.** No `.env`, RCON/AMP passwords, `SESSION_SECRET`,
   admin credentials, session cookies, panel DBs, or PZ DBs — in code, tests,
   fixtures, docs, or commit messages.
2. **Never expose RCON publicly.** RCON is plaintext; it stays on
   `127.0.0.1` (plus an explicit firewall DROP for external traffic in the
   reference deployment).
3. **Never pass browser/user input to a shell or to systemctl.** The systemd
   integration runs a fixed unit name from config with a hard verb allowlist,
   via argv `spawn` — no `sh -c`, no string interpolation, ever.
4. **Never run ZPanel or the PZ server as root.** Reference users: `zpanel`
   (panel), `pzserver` (game). Root-owned files created by accident in PZ
   directories have caused real production bugs here.
5. **Never "fix" permissions with `chmod 777`.** Use ownership and (default)
   ACLs scoped to exactly the files the panel must touch.
6. **Never write to PZ-owned files/DB without understanding ownership.** The PZ
   database (`db/<name>.db`) is **read-only** to the panel. Config files are
   written only through backup + atomic-write helpers.
7. **Never conflate panel users with PZ players/whitelist.** Two different
   domains, two different stores, two different APIs (`/api/users` vs
   `/api/whitelist`). See §10.
8. **Never conflate Workshop IDs with Mod IDs**, and **never assume one
   Workshop item exposes exactly one Mod ID.** See §9.
9. **Never bypass server-side role authorization.** Every route declares its
   guard (`requireAuth` / `requireRole`). Hiding a frontend button is never the
   boundary.
10. **Never make AMP mandatory.** AMP is one optional adapter behind
    `ServerRuntimeAdapter`. Core modules must keep working with `systemd` and
    `standalone`.
11. **Never couple domain modules to a concrete runtime adapter.** They import
    the `runtime` facade / adapter interface only (`test/no-amp-coupling.test.ts`
    enforces this).
12. **Never kill arbitrary Java processes** (`pkill java`, `killall java`). Two
    PZ servers can coexist on one machine (AMP + standalone). Process discovery
    is scoped by server name — see §7.
13. **Never restart/stop AMP or its PZ instance while working on the standalone
    runtime** unless that is explicitly the requested task.
14. **Never perform destructive live tests silently** (stop/restart/ban/remove
    mod/config mutation against a real server). See §14.
15. **Always preserve backup + atomic write for every config mutation.** No
    direct `writeFile` to a PZ config, ever.
16. **Always run the full gate before production deployment:** lint, typecheck,
    tests, build. See §15.
17. **Always update documentation with behavior changes** — README for operator
    behavior, this file for invariants — in the same change set. See §17.
18. **Never return fabricated data.** Unavailable metrics are `null`; RCON
    mutations report honest `accepted`/`confirmed` — never a blind `ok: true`.
19. **Never let secret values leave the backend.** Settings reads mask secret
    ini keys; user-management responses and audit rows carry no password
    material (tests enforce this).

---

## 2. Repository layout

```
ZPanel/                               <- repo root
├── README.md                         <- operator/installer documentation
├── AGENTS.md                         <- this file
├── .gitignore                        <- excludes secrets/runtime data (§16)
├── Zomboid_Server_Control.dc.html    <- THE frontend page (deployed as index.html)
├── api.js                            <- frontend -> backend API adapter (§12)
├── support.js                        <- frontend template runtime (do not edit casually)
│
└── backend/
    ├── package.json                  <- scripts: dev/lint/typecheck/test/build/seed:admin
    ├── tsconfig.json                 <- strict TS, CommonJS, ES2022
    ├── eslint.config.js / vitest.config.ts
    ├── .env.example                  <- annotated config template (placeholders only)
    ├── docs/                         <- deep-dive docs (architecture, API, security, AMP)
    ├── scripts/seed-admin.ts         <- bootstrap/reset a panel user (server-side only)
    │   generate-settings-schema.ts   <- regenerate the .ini schema from PZ's comments (§8a)
    │
    ├── src/
    │   ├── server.ts                 <- process entry: boot, timers, graceful shutdown
    │   ├── app.ts                    <- Fastify wiring: plugins, error model, routes
    │   ├── config/
    │   │   ├── env.ts                <- Zod-validated environment (single source of config)
    │   │   └── paths.ts              <- ALL filesystem paths derive here — never from requests
    │   ├── db/index.ts               <- panel SQLite: users, sessions, audit, scheduled_ops
    │   ├── plugins/auth.ts           <- session decode, CSRF+origin hook, requireAuth/requireRole
    │   ├── shared/                   <- errors (stable codes), logger, lock, retry, validation
    │   │
    │   ├── integrations/             <- talks to the outside world; no HTTP concerns
    │   │   ├── runtime/              <- ServerRuntimeAdapter + amp/systemd/standalone adapters,
    │   │   │                            capability gating facade, transitional-state overlay
    │   │   ├── systemd/service.ts    <- fixed unit, verb allowlist, argv spawn (§6)
    │   │   ├── amp/                  <- AMP HTTP API + ampinstmgr CLI (optional, §13)
    │   │   ├── os/proc.ts            <- PZ process discovery + /proc metrics (§7)
    │   │   ├── rcon/                 <- client, command builders, parsers, mutation semantics (§11)
    │   │   ├── zomboid-files/        <- ini/sandbox read+patch, backups+atomic write,
    │   │   │                            mod.info discovery, workshop scanning,
    │   │   │                            JVM heap config (ProjectZomboid64.json) (§7, §8)
    │   │   │                            sandbox.ts = safe Lua cursor parser (§8b)
    │   │   ├── zomboid-db/players.ts <- READ-ONLY queries on db/<name>.db (whitelist, accounts)
    │   │   └── logs/tail.ts          <- DebugLog tailing/parsing for the SSE stream
    │   │
    │   └── modules/                  <- HTTP routes + domain services (one dir per domain)
    │       ├── auth/                 <- login/logout/me, sessions, roles, Argon2id
    │       ├── users/                <- PANEL user management (admin-only; §10)
    │       ├── server/               <- overview, metrics history, lifecycle, scheduled ops
    │       ├── players/              <- online players + moderation, confirm-after-mutate
    │       ├── whitelist/            <- PZ whitelist via RCON + DB confirmation (§10, §11)
    │       ├── settings/             <- <name>.ini editor: schema.generated.ts
    │       │                            (GENERATED, §8a) + categories.ts + types.ts
    │       ├── sandbox/              <- <name>_SandboxVars.lua editor: schema.generated.ts
    │       │                            (GENERATED, §8b) + categories.ts + types.ts
    │       ├── mods/                 <- Workshop/Mods model + associations store (§9)
    │       ├── console/              <- RCON console behind a strict command allowlist
    │       ├── admin/                <- fixed action registry (browser sends ids only)
    │       ├── logs/                 <- log list + SSE stream
    │       ├── activity/             <- audit recording + feed
    │       └── system/               <- /health + admin-only integration/capability report
    │
    └── test/                         <- vitest suites + fixtures/ (fixture ini/lua are FAKE data)
```

Not in Git (deployment artifacts / runtime data): `backend/dist/`,
`backend/node_modules/`, `backend/data/`, `backend/.env`, `public/` (deploy
staging copy of the frontend), PZ installs under `/srv/project-zomboid/`,
`mockApi.js` (legacy pre-backend mock, retired).

---

## 3. Architecture & dependency direction

```
HTTP route (modules/*/routes.ts)     <- auth guard + Zod parse + audit
        │
domain service (modules/*/service.ts)
        │
integration abstraction (integrations/*)
        │
concrete mechanism: runtime adapter / files / RCON / PZ DB / /proc
```

Import rules:

- `modules/**` may import `integrations/**` **only through their public
  service/facade** (`runtime`, `rcon`, zomboid-files service, …).
- `modules/**` and `integrations/rcon|zomboid-*|os|logs` must **never** import
  `integrations/amp/**` or `integrations/systemd/**` directly. Only the runtime
  adapters do. (`test/no-amp-coupling.test.ts` + `test/runtime-systemd.test.ts`
  enforce this.)
- `integrations/**` never imports from `modules/**` (no upward dependencies),
  and nothing imports HTTP types outside `modules/*/routes.ts` + `plugins/`.
- All configuration flows from `config/env.ts`; all filesystem paths flow from
  `config/paths.ts`. **No other file builds a PZ path.**

---

## 4. Runtime contract (`ServerRuntimeAdapter`)

Defined in `integrations/runtime/types.ts`:

```ts
interface ServerRuntimeAdapter {
  name: string;
  capabilities(): RuntimeCapabilities;   // { runtime, lifecycle, metrics, update, durableServerSettings }
  getStatus(): Promise<RuntimeStatus>;   // state: running|stopped|starting|stopping|restarting|updating|unknown
  getMetrics(): Promise<RuntimeMetrics>; // cpuPercent/memoryBytes/memoryLimitBytes/uptimeSeconds — null when unknown
  start()/stop()/restart(): Promise<void>;
  update?(): Promise<void>;              // present ONLY when capabilities().update
  healthy(): Promise<boolean>;
}
```

Current adapters and capabilities:

| Adapter | lifecycle | metrics | update | durableServerSettings |
|---|---|---|---|---|
| `standalone` (default) | ✘ | ✔ (/proc) | ✘ | ✔ |
| `systemd` (recommended) | ✔ | ✔ (/proc) | ✘ | ✔ |
| `amp` (optional) | ✔ | ✔ | ✔ | ✘ (AMP regenerates the ini on restart) |

Rules:

- **`standalone` is the default**, and an unknown `PZ_RUNTIME` falls back to it —
  never to AMP or systemd. The default must stay the adapter that cannot act on
  a service the operator did not explicitly opt into. Tests pin
  `PZ_RUNTIME=standalone` so no suite can reach a real unit or AMP instance.
- Selection is server-side only (`PZ_RUNTIME`); the `Runtime` facade in
  `integrations/runtime/index.ts` gates operations by capability and throws
  `NOT_SUPPORTED` (HTTP 501) for unsupported ones. **Never assume a capability**
  — check `capabilities()`; the frontend gets them via
  `/api/system/connections`.
- `durableServerSettings=false` means the runtime may regenerate PZ config
  files; settings responses must keep surfacing this honestly.
- A new runtime (docker, k8s, …) = new adapter file + a `createRuntime` case +
  capability declaration + tests. No domain-module changes should be needed —
  if they are, the abstraction is being broken.

## 5. Frontend ↔ backend

- `api.js` is the **only** frontend API layer: `http()` sends credentials +
  `x-csrf-token`, normalizes errors (backend `error.message` surfaces to
  toasts), and exports per-domain objects (`serverApi`, `playersApi`,
  `whitelistApi`, `usersApi`, `settingsApi`, `sandboxApi`, `modsApi`,
  `logsApi`, `consoleApi`, …). Do not scatter raw `fetch` calls through UI code.
- The page (`Zomboid_Server_Control.dc.html`) is a compiled DC-runtime template;
  handlers are class fields on the app component. **Class fields with the same
  name silently shadow each other** — this caused a real production bug (§12).
- No mock data in production: `mockApi.js` is retired and must not return.
  Unknown values render as `—`/`null`, never as invented numbers.

## 6. systemd security model (`integrations/systemd/service.ts`)

- The unit name comes from `env.SYSTEMD_UNIT` — **fixed server-side config**.
  There is no code path where a request value reaches systemctl, and it must
  stay that way. Anti-patterns that must never appear:
  `systemctl ${req.body.unit}`, `spawn('sh', ['-c', ...])`.
- Verbs are a hard allowlist (`start`, `stop`, `restart`); commands are built
  as a fixed argv array `['systemctl', verb, UNIT]` run via `spawn` with sudo
  only when needed.
- The matching sudoers rule (`/etc/sudoers.d/zpanel-pz` in the reference
  deployment) lists the three exact `systemctl <verb> <unit>` command lines for
  the `zpanel` user — no wildcards. Read-only queries (`is-active`) need no
  privilege.
- `test/runtime-systemd.test.ts` asserts the allowlist, fixed unit, and argv
  spawn at source level. Keep those assertions truthful.

## 7. Process discovery & metrics (`integrations/os/proc.ts`)

- The managed PZ process is found by scanning `/proc/*/cmdline` for a PZ
  signature (`zombie.network.GameServer` for AMP-style Java launches, or
  `ProjectZomboid` for launcher-style) **AND** `env.PZ_SERVER_NAME` in the same
  command line. This is what keeps two coexisting PZ servers from
  cross-matching. Never loosen this to "any java process".
- CPU% is computed from utime+stime deltas between samples (first sample after
  a pid change yields `null`); uptime derives from `/proc/<pid>/stat` starttime.
- Memory **usage** prefers `Pss` from `smaps_rollup` (PZ Build 42 runs ZGC,
  which multi-maps the heap, so plain `VmRSS` can multi-count those pages),
  falling back to `VmRSS`. Usage is never the heap ceiling.
- The memory **ceiling** (dashboard "of N GB limit") resolves: the process's
  own cmdline `-Xmx` (AMP-style `java` launches carry it) → the authoritative
  launcher config `ProjectZomboid64.json` in `paths.pzInstallDir`
  (launcher-style processes read `-Xmx` from there; see
  `zomboid-files/jvm-config.ts`) → `null`. **Never a hardcoded fallback** —
  `test/jvm-config.test.ts` + `test/runtime-label.test.ts` guard this.
- The overview's `runtime` field (from `runtime.capabilities().runtime`) drives
  the frontend's runtime badge (`SYSTEMD + RCON`, `AMP + RCON`, …). Labels are
  derived, never hardcoded per-runtime in the frontend.
- `/proc` is **read-only** observation. This module never signals, kills, or
  spawns anything.
- Missing data stays `null` — do not substitute zeros or estimates (except
  state `stopped`, which legitimately reports zeroed usage).

## 8. Filesystem rules

- Authoritative locations (all derived in `config/paths.ts` from
  `PZ_SERVER_DIR` / `PZ_ZOMBOID_DIR` / `PZ_WORKSHOP_DIR`):
  - `<serverDir>/<name>.ini` — read+patch (settings, mods lists).
  - `<serverDir>/<name>_SandboxVars.lua` — read+patch (sandbox).
  - `<zomboidDir>/db/<name>.db` — **read-only** (whitelist/accounts queries).
  - `<zomboidDir>/Logs/` — read-only (log tailing).
  - Workshop/local mod dirs — read-only (mod.info discovery).
  - `<installDir>/ProjectZomboid64.json` — **read-only** (configured JVM heap;
    the panel reports it, it does not manage it).
  - `<serverDir>/.zpanel-backups/` — the only panel-owned write location
    besides the two config files and the panel data dir.
- Every config mutation goes through `zomboid-files/backups.ts`:
  `backupFile()` (timestamped copy, retention 10 per file) then
  `atomicWrite()` (same-dir temp file + fsync + rename, preserving mode).
- Patch semantics: read → modify only intended keys → write whole file
  atomically. Unknown/unrelated keys and comments are preserved.
- **No path from HTTP input.** Route parameters select *entities* (usernames,
  workshop ids), never file names or paths. If you need a new file, add it to
  `paths.ts`.
- ACL assumption in production: the panel user has rw on exactly the two config
  files (+ backups dir), read elsewhere. Code must tolerate EACCES with a clean
  `CONFIG_WRITE_FAILED`/forbidden error, not crash.

## 8a. Server settings (`<name>.ini`)

- **Schema location & provenance.** `src/modules/settings/schema.generated.ts`
  is GENERATED — do not hand-edit. `scripts/generate-settings-schema.ts` parses
  a server-generated `<name>.ini` and lifts PZ's own metadata out of its `#`
  comments: description, `Min: x Max: y Default: z`, and inline enum legends in
  both PZ spellings (`1=Hidden 2=Friends` and `1 - ban, 2 - kick`). Grouping,
  labels, secrets and restart/live semantics are hand-maintained in
  `categories.ts`. Currently **142 keys across 16 groups**.
- **Generate from the repo fixture, never from a production file.**
  `test/fixtures/servertest.ini` is the source (fake data, secrets already
  redacted). Only METADATA is emitted — never a sample VALUE. A leaked value
  would put a real server's config, or a password, into Git.
  `test/settings-schema.test.ts` asserts no sample value appears in the output.
- **It is an ALLOWLIST, not an arbitrary ini editor.** A key absent from the
  schema is never written, and unknown ini content is preserved by patch
  semantics. Per-kind validation is authoritative server-side: PZ's own
  min/max, int-ness, enum membership, and a hard rejection of CR/LF in text
  (a newline would smuggle a second key into the file).
- **`Mods` / `WorkshopItems` are excluded and must stay excluded**
  (`EXCLUDED_KEYS`). The Mods page owns them (§9); exposing them here would let
  a settings save overwrite the mod list with a stale browser copy. Tests pin
  this.
- **Never claim `live` without verifying it.** Every field is either `live`
  (a runtime `changeoption` + `reloadoptions` is known to take effect) or
  `restart: true`. Default is `restart` — being wrong in that direction is
  harmless; claiming a change applied when it did not is fabricated data
  (§1 rule 18). Promote a key to `live` only after testing it on a real server,
  and add it to `POLICY`.
- **Saves send only the CHANGED keys.** With the schema covering the whole file,
  posting every field would rewrite the entire allowlisted surface from a
  possibly stale page. The frontend sends `{ key: value }` for dirty fields only.
- Keys PZ writes only in some configurations (e.g. `AutoCreateUserInWhiteList`)
  are declared by hand in `EXTRA_FIELDS`. As with sandbox, a field absent from
  the live file is never displayed and never introduced.
- Any schema, generator, grouping or validation change REQUIRES updated
  `test/settings-schema.test.ts` (coverage, containment, honesty of semantics).

## 8b. Sandbox settings (Build 42)

- **Schema location & provenance.** `src/modules/sandbox/schema.generated.ts` is
  GENERATED — do not hand-edit. `scripts/generate-sandbox-schema.ts` parses a
  server-generated `*_SandboxVars.lua` and lifts PZ's own metadata out of its
  `--` comments: description, `Min: x Max: y Default: z`, the numeric enum
  legend (`-- 1 = Insane`), and the `<BHC> [!] … [!] <RGB:…>` advisory markup.
  UI grouping/labels live in the hand-maintained `categories.ts`. Regenerate
  after a PZ update and review the diff. Currently **269 vanilla fields**.
- **Never execute Lua to read or write config.** No `eval`, `new Function`,
  `loadstring`, or a Lua VM — the parser is a hand-written cursor
  (`integrations/zomboid-files/sandbox.ts`) and the writer splices only the
  changed value literals.
- **A schema `default` is NOT the live value.** Defaults are informational.
  Displayed values come solely from the server's own SandboxVars.lua, and a
  field absent from that file is never displayed and never introduced —
  absence means "PZ's own default behavior".
- **Never regenerate SandboxVars from known fields.** A save must patch in
  place. Unknown vanilla options, future options, comments, formatting and
  mod-added sections (e.g. `DAMN = { … }`) must survive byte-for-byte. The
  round-trip tests assert this against a real Build 42 fixture.
- **Nested paths are authoritative.** `ZombieLore.Speed` addresses
  `ZombieLore = { Speed = … }` — never a literal dotted key in the file. The
  parser recurses to arbitrary depth; do not add per-table special cases.
- **Preserve Lua types**: bare `true`/`false` (never `"true"`), floats keep
  their float spelling (`2.0`), ints stay bare, empty strings stay `""` (never
  null).
- **Enum values are explicit `{value,label}` pairs**, not index positions, so a
  non-contiguous legend keeps mapping correctly.
- **Backend bounds are authoritative**: PZ's own Min/Max (and int-ness) are
  enforced server-side, so a request that bypasses the UI is rejected.
- Any schema, parser, or writer change REQUIRES updated round-trip +
  preservation tests (`test/sandbox-b42.test.ts`).

## 9. Mods engineering model (get this right)

Two identifier spaces, stored in `<name>.ini` as two flat lists with **no
recorded relationship**:

- `WorkshopItems=` — numeric Steam **Workshop IDs** (what SteamCMD downloads).
  Validation: `/^\d{6,12}$/`.
- `Mods=` — textual **Mod IDs** from each mod's `mod.info` (what the game
  loads, in list order). Validation: letters/digits/`_`/`.`/`-` only.

Invariants:

- **Workshop ID ≠ Mod ID. One Workshop item may contain many Mod IDs.**
- **Never pair the two lists positionally.** Index `i` of one list has no
  relationship to index `i` of the other.
- Ownership resolution order (`modules/mods` + `zomboid-files/workshop-discovery`):
  1. **`mod.info` on disk** for the Workshop item's downloaded content —
     authoritative.
  2. **Recorded association** (`mod-associations.json` in the panel data dir) —
     what the admin asserted at add time, used until content exists on disk.
  3. **Unresolved** — surfaced for manual assignment; also "standalone" Mod IDs
     (present in `Mods=` with no known Workshop owner) are first-class and
     removable via their own endpoint.
- Operations: add (workshop id + chosen/discovered mod ids), remove (workshop
  item removes its owned mod ids; standalone mod ids removed individually),
  enable/disable (toggle presence in `Mods=` while keeping the association),
  move (load-order reordering within `Mods=`), update check via RCON
  `checkModsNeedUpdate`.
- Both lists are deduplicated on write; writes go through the standard
  backup + atomic pipeline.
- Rejecting `;`, newlines, paths, and shell metacharacters in IDs is a
  **security** control, not pedantry: these values are written into the
  server's config line (`;`-separated) and must never be able to smuggle in
  extra entries or escape the field.

## 9b. Mod update checks

- **PZ cannot name an outdated mod.** `checkModsNeedUpdate` writes only
  `CheckModsNeedUpdate: Mods need update.` — a verdict for the whole
  collection. Any code that reports "N mods need updating" from that alone is
  giving the operator nothing; that was a real complaint about this panel.
- Identity and versions come from three sources, in this order of authority:
  1. **Steam's public Workshop API** (`integrations/steam/workshop-api.ts`) —
     the published `time_updated` per item. Compared against the installed
     timestamp, this is what names the stale mods. Optional
     (`STEAM_WORKSHOP_API`), key-less, bounded by `AbortController`, and it
     must NEVER make the check fail or hang — offline degrades to (2)/(3).
  2. **Steam's install manifest** (`zomboid-files/workshop-manifest.ts`,
     `appworkshop_<appid>.acf`, READ-ONLY) — downloaded yes/no, installed
     content version, manifest id, size. Absent item = not downloaded; absent
     FILE = unknown, and the two must stay distinguishable
     (`installStateKnown`).
  3. **The game server's log** (`logs/mod-updates.ts`) — `Workshop: …
     GetItemState()=…|NeedsUpdate|… ID=<id>` lines, the only per-item signal PZ
     emits, and only while Steam is actively downloading.
- **`needsUpdate` is `boolean | null`, and `null` means "could not determine".**
  Never default it to false/true from silence, and always report `source`
  (`steam` | `server` | `unknown`) so the UI can be honest (§1 rule 18).
- `GET /api/mods` stays local-only (no outbound call) and carries the install
  facts; the Workshop comparison happens only on the explicit check action.
- **The check must WRITE its verdict where the list can read it.** `updateStatus`
  used to be hardcoded `'unknown'` with no writer anywhere, so the Update action
  filtered on it and always found zero — the panel would say "CleanUI needs
  update" and "nothing to update" in the same session. `checkModUpdates` now
  populates an in-memory cache that `listWorkshopItems` applies. Keep any new
  status field written by something, or it is decoration.
- **`POST /api/mods/update` downloads nothing, and must never claim it did.**
  Project Zomboid fetches Workshop content itself at STARTUP (verified in the
  log: one item query across the collection on boot, then downloads for anything
  flagged NeedsUpdate). A panel-side SteamCMD run would race the process that
  owns the install. The endpoint reports `{ ok: false, applyVia: 'restart',
  pending[] }` and the UI offers the restart. It also distinguishes "no check has
  run" from "nothing pending" — those are different answers.
- The mods module stays runtime-agnostic: `mods.test.ts` forbids importing
  `integrations/runtime` here, so the update-apply path must not branch on
  runtime capabilities. "Restart applies Workshop updates" is true for every
  runtime because it is the game's own behaviour.
- Format changes in PZ's log lines break identification silently, so
  `test/mod-updates.test.ts` pins the verbatim shapes captured from a live
  Build 42 server. Update those fixtures from a real log, never from memory.

## 10. Authentication, authorization & the two user domains

- **Panel users** live in the panel SQLite DB (`users` table, Argon2id
  hashes). Roles: `admin` > `moderator` > `readonly` (ids exactly these
  strings; UI labels Admin / Moderator / Read Only). Managed only via
  `/api/users` (admin-only), bootstrapped only via `scripts/seed-admin.ts`.
- **PZ players/whitelist** live in PZ's own `db/<name>.db`, mutated only via
  RCON whitelist commands. Managed via `/api/whitelist`.
- **These domains never cross.** Creating a panel user must not touch RCON, the
  PZ DB, or the whitelist — and vice versa. `users/routes.ts` +
  `users/service.ts` contain no whitelist/RCON/player references
  (`test/frontend-userdialog.test.ts` enforces this at source level).
- Server-side checks are the only authorization: `requireAuth` /
  `requireRole(min)` on every route, rank-based (`readonly=0, moderator=1,
  admin=2`).
- **Admin-only:** Users & Access (`/api/users*`), console (`/api/console`),
  **Activity Log viewing (`GET /api/activity`)**, whitelist mutations, **server
  start/stop/update**, **mod load-order moves and content updates**, privileged
  player actions, system connections. Audit **recording** covers every role —
  restricting who VIEWS the trail never disables writing to it.
- **Configuration writes are `moderator` (INTENTIONAL — do not "restore" these
  to admin):**

  ```
  PUT /api/settings   requireRole('moderator')   -> admin + moderator
  PUT /api/sandbox    requireRole('moderator')   -> admin + moderator
  ```

  `readonly` gets 403, unauthenticated gets 401. Rationale: config edits are
  allowlisted, schema-validated, backed up before every write, atomic, and
  reversible — the day-to-day tuning a moderator is there to do. This is a
  deliberate product decision; a future change set must not silently narrow it
  back to `requireRole('admin')`. `test/config-write-authz.test.ts` pins the
  matrix, the pipeline guarantees and the audit attribution.

  What this grant does **NOT** include, and what must stay admin-only unless
  changed just as deliberately: Users & Access, Activity Log, Server Console,
  lifecycle start/stop/update, system connections. A moderator must never
  become a second admin as a side effect of a config-permission change.
  `test/route-authz.test.ts` asserts the 403s that keep that true.
- **Config write ≠ lifecycle.** A settings save may report
  `restartRequired: true`; it must never restart, schedule a restart, or imply
  restart authority. Reporting the fact is allowed for every role that may
  save; performing the restart is separately guarded (`moderator` for restart,
  `admin` for start/stop/update).
- **Lifecycle is split by recoverability:** `POST /api/server/restart` (and
  cancelling a scheduled restart) is `moderator` — the server comes back on its
  own; `start`/`stop`/`update` stay `admin` because they leave it down or change
  installed content. Keep the frontend gate (`can.moderate` on Restart,
  `can.admin` on Stop/Start) in step with these guards.
- **Mod curation is `moderator`:** lookup, add, remove (Workshop item and
  standalone Mod ID), enable/disable, and update checks. Load-order `move` and
  the content-update stub stay `admin`. Two constraints to preserve when
  touching these: `lookup` is step 1 of the add flow, so it can never be more
  restricted than add; and `toggle` only edits `Mods=` while keeping the
  Workshop item, so it can never be more restricted than remove — a role that
  may delete a mod must also be able to merely disable it.
- The frontend mirrors this in two maps in `Zomboid_Server_Control.dc.html`,
  both cosmetic mirrors of the backend guards:
  - `PAGE_ACCESS` — who may OPEN a page: navigation, direct-route fallback and
    role-aware data loading derive from it.
  - `CAPABILITIES` — who may CHANGE something: `editServerSettings` and
    `editSandbox` are `["admin","moderator"]`; `manageUsers`, `useConsole`,
    `viewActivity`, `controlLifecycle` and `viewConnections` are `["admin"]`.
    Read it with `hasCapability(cap, role)` / `this.may(cap)`.

  Change route guards and these maps together. Use a NAMED capability rather
  than a bare `isAdmin`/`can.admin` check whenever a mutation's role set is not
  simply "admin" — that is what keeps a permission change from leaking into
  unrelated admin surfaces. Do not sweep `can.admin` gates generically.
- **Read-only means disabled controls, not just a hidden button.** Config field
  controls bind `disabled="{{ f.locked }}"` from the capability passed into
  `decorate(f, id, onChange, dirty, editable)`, whose `onChange` becomes a
  no-op when locked, and `saveSettings`/`saveSandbox` return early unless
  `this.may(...)` — so an unauthorized role never even issues the request.
  The backend guard remains the boundary; this only avoids guaranteed 403s.
- CSRF: unsafe methods on `/api/*` require the session-bound `x-csrf-token`
  header plus an Origin/Referer check against `PANEL_ORIGINS` (login gets the
  origin check only). Login is rate-limited (8/min/IP).
- Session invalidation is part of the contract: role change, password reset,
  and disable end the target's sessions immediately.
- **Last-admin protection:** the last active admin cannot be demoted, disabled,
  or deleted (409 `CONFLICT`). Do not weaken this.
- Audit (`modules/activity`): every mutation records actor id/name/**role**,
  action (e.g. `user.create`, `whitelist.addUser`), target, non-secret details,
  success, source IP. **Never** put passwords/hashes/secrets in audit details.
- **Audit attribution is the authenticated user, always.** `actor(req)` reads
  id, username and role off the session — a privileged operation is never
  recorded as `admin` merely because it is privileged. A moderator's config
  save appears as `actorRole: 'moderator'`, `action: 'settings.save'` /
  `'sandbox.save'`, and the admin sees exactly that in the Activity Log.
  (`audit.actor_role` is nullable and added by an idempotent migration in
  `db/index.ts`; rows written before it exist simply have no role.)

## 11. RCON semantics (`integrations/rcon/`)

- RCON talks to `127.0.0.1` only, with the password from `.env`. The console
  module exposes it to admins **through `modules/console/allowlist.ts`** — a
  fixed set of game commands with a safe-character line filter. `quit` is
  deliberately excluded (lifecycle endpoints own stop/restart).
- **Accepted ≠ confirmed.** PZ's RCON returns prose, not machine acks, and some
  commands "succeed" even when they did nothing. The mutation model
  (`rcon/mutations.ts`):
  - `accepted` — the reply did not match known rejection phrases.
  - `confirmed` — an authoritative source verified the effect afterwards
    (players list, PZ DB), usually with retry (`confirmWithRetry`, ~5×300ms).
  - `confirmation`: `verified` | `unconfirmed` | `unavailable` | `rejected`.
- Confirmable mutations (kick/ban/access-level/whitelist add+remove/steamid
  add+remove) **must** verify against the players list or PZ DB. Commands with
  no queryable state (godmode, noclip, additem, addxp, addvehicle, weather,
  broadcast) honestly return `confirmation: 'unavailable'` — never invent
  `confirmed: true`.
- New RCON commands go in `rcon/commands.ts` (builders) with parsing in
  `rcon/parsers.ts` and tests; never build command strings inline in modules,
  and never interpolate unvalidated input into a command.

## 12. Frontend rules

- `api.js` is the API abstraction (§5). UI code calls `<domain>Api.*` only.
- **Panel Users and Whitelist are separate dialogs, handlers, and APIs.**
  Invariant (regression-tested after a real production bug where a duplicated
  `openAddUser` class field made *Users & Access → Add User* open the whitelist
  dialog): the panel-user dialog calls `usersApi.create` and never
  `whitelistApi`; the whitelist dialog (`openAddWhitelistUser`) calls
  `whitelistApi.addUser` and never `usersApi`. `test/frontend-userdialog.test.ts`
  guards the wiring — keep it passing and extend it if you touch these flows.
- Watch for class-field shadowing generally: two same-named fields on the app
  component compile fine and the later silently wins.
- Role gating in the UI is cosmetic UX; the backend check is the boundary.
- **Bootstrap invariant: never eagerly request endpoints the authenticated role
  cannot access.** `load()` resolves `authApi.me()` FIRST, then fetches only
  role-authorized domains (admin-only domains like console/activity are simply
  not requested for other roles). Discovering a 403 the hard way is a bug.
- **Bootstrap invariant: a forbidden or failed optional domain must never
  prevent Dashboard bootstrap.** Only the critical dashboard set (overview,
  history, players) may block; every other domain loads independently with its
  own error handling, and every bootstrap attempt ends with `loading: false` —
  either data-ready or a visible error state, never a permanent spinner. (This
  class of bug shipped once: a moderator's dashboard hung forever because the
  admin-only `/api/console` sat in the bootstrap `Promise.all`.
  `test/frontend-rbac.test.ts` guards the wiring.)
- Do not fabricate data client-side; render backend nulls as `—`.
- Never render or store passwords beyond the create/reset form fields; there is
  no "show existing password" anywhere.

## 13. AMP coexistence

- The product supports AMP, but the reference production ZPanel manages a
  **separate standalone/systemd PZ server**; an AMP-managed PZ server coexists
  on the same machine, untouched.
- Consequences you must respect:
  - There may be **two** PZ Java processes. Never `pkill java` / `killall
    java`; never assume "the" PZ pid (§7's name-scoped matching exists for
    this).
  - When `PZ_RUNTIME=systemd`, never read/write AMP instance paths, and never
    start/stop/restart AMP or its instance.
  - AMP restarts its instance on its own schedule — an AMP-side pid change is
    not a ZPanel event.
  - Port pairs differ per server (reference: AMP on 16261/16262 + RCON 27015;
    standalone on 16361/16362 + RCON 27115). Check ports before concluding
    anything about "the server".
- AMP-specific code stays inside `integrations/amp/**` + `amp.adapter.ts`
  behind the runtime interface. `AMP_*` env vars are only meaningful when
  `PZ_RUNTIME=amp`.

## 14. Live Server Safety

This repository can control live Project Zomboid processes. Before ANY
destructive or state-changing test (stop, restart, ban, delete user, remove
mod, settings/sandbox write, world mutation):

1. Identify the target runtime (`PZ_RUNTIME`) and unit/instance.
2. Identify the target process (pid, command line, `-servername`).
3. Verify the server name and ports match the server you intend to touch.
4. Verify you are **not** pointing at the coexisting AMP server.
5. Have explicit approval that a live test is in scope; otherwise use the test
   suite's fixtures (`test/fixtures/`) and temp-dir DBs — the suites already
   isolate `PANEL_DB_PATH` per run.

Read-only inspection (status, logs, `GET` endpoints, `/proc`) is always fine.
Reversible-but-visible actions (broadcast, save) still deserve a mention before
running them against production.

## 15. Testing & the verification gate

- Framework: **vitest** (`backend/test/*.test.ts`, fixtures in
  `test/fixtures/` — fixture configs are fake data, not production copies).
- The gate, required before any production deployment and before declaring a
  change done:

  ```bash
  cd backend
  npm run lint && npm run typecheck && npm test && npm run build
  ```

- Current suite: 22 files / 289 tests. **This count is non-authoritative and
  expected to grow** — never treat "the number of tests" as an invariant, but a
  *drop* without explanation means something was deleted.
- Changes that REQUIRE new/updated tests:
  - auth/session/CSRF/role changes (`users.test.ts`, `console-authz.test.ts`,
    `route-authz.test.ts`, `config-write-authz.test.ts`, `frontend-rbac.test.ts`)
  - settings/sandbox write permissions or pipeline (`config-write-authz.test.ts`
    — it runs the real routes against isolated temp copies of the fixtures and
    asserts the role matrix, backup/atomic/validation behavior and audit
    attribution together; never point it at a real server directory)
  - runtime adapter or capability changes (`runtime*.test.ts`,
    `no-amp-coupling.test.ts`)
  - any filesystem mutation path (`ini.test.ts`, `sandbox.test.ts`)
  - server-settings schema/generator/grouping (`settings-schema.test.ts`)
  - Mods/Workshop semantics (`mods.test.ts`, `mapping-lock.test.ts`)
  - mod update detection / log shapes (`mod-updates.test.ts`, §9b)
  - RCON commands/parsers/mutation semantics (`rcon-*.test.ts`)
  - API contract changes (status codes, payload shapes)
  - frontend user/whitelist dialog wiring (`frontend-userdialog.test.ts`)
- Test conventions worth knowing: login helpers use a unique
  `x-forwarded-for` per login (login rate limit is 8/min/IP); only set a JSON
  content-type when a body exists (Fastify rejects empty JSON bodies);
  usernames need ≥ 3 chars; suites point `PANEL_DB_PATH` at an isolated temp DB
  **before** importing the app.

## 16. Repository hygiene & secrets

- `.gitignore` (root + backend) excludes: `node_modules/`, `dist/`, `.env*`
  (except `.env.example`), `data/`, `*.db*`, logs, coverage, `public/` (deploy
  staging), backups, and OS noise. Test fixtures are explicitly kept.
- Before any commit that adds files, scan for: `password`, `secret`, `token`,
  real RCON/session values, credential file paths, and deployment-specific
  values embedded in generic source.
- Things that must NEVER enter Git: production `.env`, panel DB, PZ DB, world
  saves, server logs, SteamCMD/PZ binaries, Workshop content, credential files
  (e.g. anything under `/root/`), TLS keys.
- API error payloads and logs must not leak stack traces or secrets (the global
  error handler already enforces the shape `{ error: { code, message } }` with
  stable codes: 400 `INVALID_INPUT`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN`,
  404 `NOT_FOUND`, 409 `CONFLICT`/`OPERATION_IN_PROGRESS`/`SERVER_OFFLINE`,
  429 `RATE_LIMITED`, 501 `NOT_SUPPORTED`, 502 `PZ_RESPONSE_INVALID`,
  503 `RCON_UNAVAILABLE`/`AMP_UNAVAILABLE`, 500 `INTERNAL`).

## 17. Deployment & documentation maintenance

- Deployment boundaries (see README for the operator view):
  - ZPanel code: build → deploy `backend/` (excluding `.env`, `data/`) and the
    static frontend → restart **`pz-panel.service` only**.
  - Frontend-only changes: deploy statics; **no restart needed**.
  - PZ config/JVM changes: restart the PZ unit **only when required**, via its
    graceful stop path. Never as collateral of a panel deploy.
  - Never restart the AMP server as collateral of anything.
- Documentation contract: `README.md` = operator-facing behavior; `AGENTS.md` =
  engineering invariants. When you change behavior, update implementation,
  tests, and the relevant doc **in the same change**. Triggers include: new env
  var, new runtime adapter, role/permission change, new/changed API endpoint,
  filesystem layout change, Mods semantics, deployment procedure, security
  posture.
- Documentation-only changes require no service restarts and no deploys.
