# Discovery — the real AMP / Project Zomboid environment

Everything below was verified against the running server before implementation.
The mock frontend was treated as the UX contract, **not** as a source of truth.

## Host

- OS: Ubuntu; AMP by CubeCoders manages the Project Zomboid dedicated server.
- `ampinstmgr` v2.6.4.2; instance binary AMP v2.8.0.4 (Mainline).
- Instance runs the game in a Docker container; `/AMP/...` inside maps to the
  host instance directory.

## AMP instance: `ZMochileiros01`

- InstanceID `46107bbe-6f11-41a5-84ce-21895bbf902d`, AppModule **GenericModule**.
- Webserver `127.0.0.1:8083`; auth via ADS at `localhost:8080`; login user `admin`.
- Lifecycle verbs (as the `amp` user): `ampinstmgr --StartInstance|--StopInstance|
  --RestartInstance|--UpgradeInstance <instance>`.
- **AMP owns the PZ config.** `GenericModule.kvp → App.AppSettings` is AMP's source
  of truth and is used to (re)generate `servertest.ini`. Direct ini edits to
  AMP-owned keys are overwritten on restart. `SandboxVars.lua` is **not** in
  AppSettings → safe to edit directly. See [AMP.md](AMP.md).

## RCON (native Project Zomboid)

- `127.0.0.1:27015`, Source RCON protocol — **live-verified** (auth, `players`,
  `save`, `help`, `showoptions` all succeed).
- `players` with nobody connected returns exactly `Players connected (0): \n`.
- This is **Build 42** (the mock's `41.78.16` is wrong). Confirmed command syntax
  from the live `help`:
  - `kickuser "user" -r "reason"`
  - `banuser "user" -ip -r "reason"`
  - `setaccesslevel "user" "Level"` — levels: **Admin, Moderator, Overseer, GM,
    Observer** (there is no "Player" level; a normal player has no elevated role).
  - powers use `-true`/`-false`: `godmodplayer`, `invisibleplayer`, `noclip`.
  - `additem "user" "Module.Item" count`, `addxp "user" Perk=amount`,
    `addvehicle "Module.Vehicle" "user"`, `servermsg "text"`,
    `changeoption name "value"` + `reloadoptions`.
  - `checkModsNeedUpdate` acknowledges and writes the result to the log file.

## Access levels (Build 42 role system)

The PZ account DB stores access level as a **role**:

| role id | name | frontend label |
|---|---|---|
| 7 | admin | Admin |
| 6 | moderator | Moderator |
| 5 | gm | GM |
| 4 | observer | Observer |
| 3 | priority | Player |
| 2 | user | Player |
| 1 | banned | Player (banned=true) |

## SQLite `db/servertest.db` (read-only)

The source of truth for **offline players, whitelist, and bans**:

- `whitelist` — `username, steamid, displayName, role, lastConnection` (4 accounts
  found: `admin`, `kvr`, `Janjaro`, `Xico`).
- `role` — id → name (above).
- `allowedsteamid` — the SteamID allow-list (currently empty).
- `bannedid` / `bannedip` — bans with reasons.
- `userlog` — moderation history.

The panel opens this database **read-only** and never mutates it; all mutations go
through RCON, which updates the database itself.

## Sandbox (`servertest_SandboxVars.lua`)

- Lua table with one level of nested tables (`ZombieLore`, `Map`, `ZombieConfig`,
  `MultiplierConfig`, `Basement`), ~270 keys, interleaved with `--` comments.
- Enum legends were read from the file's own comments (authoritative). Notable
  Build 42 differences from the mock:
  - Zombie behaviour/senses are nested under **`ZombieLore.*`** (e.g.
    `ZombieLore.Speed`, `ZombieLore.Transmission`), not top-level.
  - `Speed`: 1 Sprinters, 2 Fast Shamblers, 3 Shamblers, 4 Random.
  - `Transmission`: 1 "Blood and Saliva", 2 "Saliva Only", 3 "Everyone's Infected",
    4 None.
  - Some mock fields (`XpMultiplier`, `FoodLoot`, `WeaponLoot`) do not exist under
    those names here and are intentionally omitted rather than fabricated.
- Parsed with a deterministic recursive-descent parser (no `eval`/`Function`) that
  records each value's source span, so writes splice only changed literals and
  preserve comments/formatting/unknown fields byte-for-byte (verified: an empty
  patch reproduces the file exactly).

## Logs

- `Zomboid/Logs/*_DebugLog-server.txt`, format
  `[DD-MM-YY HH:MM:SS.mmm] LEVEL : Category ... > message`. Rotates per server start
  (timestamp-prefixed filenames). Tailer reads only appended bytes and follows
  rotation. Specialized logs also exist (`connections.txt`, `chat.txt`, `pvp.txt`,
  `user.txt`, `cmd.txt`).

## Resolved unknowns (from the task's list)

- AMP version → 2.8.0.4 instance / 2.6.4.2 ampinstmgr.
- AMP API/auth → HTTP API on `127.0.0.1:8083`, needs an AMP user; falls back to
  `ampinstmgr`.
- AMP-overwritten config → everything in `servertest.ini` (AppSettings-backed).
- PZ logs → `Zomboid/Logs`.
- Persistent player data → `db/servertest.db` (`whitelist`, `role`, etc.).
- Offline-player fields safely exposed → username, steamId, displayName, role,
  lastConnection. Others → `null`.
- Access-level command → `setaccesslevel` (Build 42 levels above).
- `checkModsNeedUpdate` → acknowledges over RCON, writes result to DebugLog;
  correlated by watching the live log for a bounded window.
- Backend user / permissions → runs as a non-root service user with read/write to
  the PZ Server dir + Logs, read-only to `db/servertest.db`, localhost RCON, and
  `sudo -n -u amp ampinstmgr` for lifecycle (see [DEPLOYMENT.md](DEPLOYMENT.md)).
