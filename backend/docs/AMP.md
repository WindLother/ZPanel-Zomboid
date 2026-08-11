# AMP integration & configuration ownership

AMP is an **optional runtime adapter** (`PZ_RUNTIME=amp`), not a core dependency —
see [ARCHITECTURE.md](ARCHITECTURE.md). Everything below applies when the AMP
adapter is selected; with `PZ_RUNTIME=standalone` none of it is used and the panel
runs without AMP (metrics via `/proc`, lifecycle unavailable).

AMP (CubeCoders) owns the Project Zomboid **process lifecycle** and much of its
**configuration**. The AMP adapter cooperates with AMP rather than fighting it.

## Lifecycle

Two mechanisms, chosen automatically:

1. **AMP HTTP API** (preferred) — when `AMP_BASE_URL` + `AMP_USERNAME` +
   `AMP_PASSWORD` are set. The client logs in (`Core/Login`), keeps the session,
   and calls `Core/Start|Stop|Restart|Update` and `Core/GetStatus` (CPU/RAM/uptime
   /state). It re-logs-in on session expiry. Credentials never reach the browser.
2. **`ampinstmgr` CLI fallback** — when API credentials are absent. Runs
   `ampinstmgr --StartInstance|--StopInstance|--RestartInstance|--UpgradeInstance
   <instance>` as the AMP system user (`sudo -n -u amp ...`, or directly if the
   backend already runs as that user). Metrics come from `/proc` of the tracked
   Java process. This path is fully functional on the host but cannot stream the
   AMP console.

We **never** `kill`/`pkill`/spawn the Java process or run a parallel systemd unit.

Graceful stop/restart: optional broadcast → RCON `save` (await result) → ask AMP to
stop/restart → track transitional status via the operation lock.

## Configuration ownership

For the `GenericModule` Project Zomboid instance, AMP stores the server config in
`GenericModule.kvp → App.AppSettings` (JSON) and regenerates `servertest.ini` from
it when it starts the process. Consequences:

| File / keys | Owner | Panel write strategy |
|---|---|---|
| `servertest.ini` (all keys) | **AMP** | Backup + atomic patch (preserving unknown keys) **and** live `changeoption`+`reloadoptions` for runtime-safe keys. Responses carry `ampManaged: true`. |
| `WorkshopItems=` / `Mods=` | **AMP** | Same as above (mod add/remove/toggle/move). |
| `servertest_SandboxVars.lua` | **Not AMP** | Safe direct patch (backup + atomic + re-parse verify). |

### The overwrite caveat — modeled as an adapter capability

This is represented as the runtime capability **`durableServerSettings: false`**
(AMP adapter) rather than by changing the configuration architecture. Configuration
files remain a Project Zomboid concern; AMP AppSettings is **not** used as a
canonical config store. The `standalone` adapter reports `durableServerSettings:
true`. The settings write endpoint returns this flag so callers know whether a
write survives a restart.

Because AMP regenerates the ini from AppSettings, a direct ini edit to an AMP-owned
key can be reverted the next time **AMP** restarts the server. The panel therefore:

- applies runtime-safe settings live (so they take effect immediately), and
- returns `restartRequired` / `ampManaged` metadata so the UI can warn.

For guaranteed durability across an AMP-initiated restart, the same value must also
reach AMP's AppSettings. The recommended options are (a) configure AMP API
credentials and extend `settingsService` to also push the change via the AMP
settings API, or (b) mirror the change in AMP's own config UI. This limitation is
surfaced rather than hidden; the panel does not pretend a write is durable when it
may not be.

Sandbox settings have no such caveat and are fully owned by the panel's file writes.
