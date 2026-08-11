# Architecture

Fastify + TypeScript. One administration app controlling one Project Zomboid
server — deliberately not microservices.

```
src/
├── server.ts              # bootstrap: build app, start tailer/metrics/schedules
├── app.ts                 # Fastify assembly: plugins, security, error model, routes
├── config/
│   ├── env.ts             # env parsing + validation (zod), .env loader
│   └── paths.ts           # centralized, server-controlled PZ file paths
├── shared/
│   ├── errors.ts          # ApiError + stable error codes
│   ├── validation.ts      # input schemas + RCON argument sanitization
│   ├── lock.ts            # operation coordinator (serializes lifecycle ops)
│   └── logger.ts          # pino logger with secret redaction
├── integrations/
│   ├── runtime/           # ServerRuntimeAdapter abstraction + selector (PZ_RUNTIME)
│   │                      #   types, overlay, amp.adapter, standalone.adapter, index
│   ├── amp/               # AMP-specific impl (HTTP client + ampinstmgr) — wrapped only
│   │                      #   by runtime/amp.adapter; no business module imports it
│   ├── os/               # neutral /proc process metrics (used by any adapter)
│   ├── rcon/              # Source RCON: client, service (pooled), commands, parsers,
│   │                      #   mutations (accepted/confirmed model)
│   ├── zomboid-files/     # ini + sandbox parsers, backups, atomic write, service
│   ├── zomboid-db/        # read-only SQLite access to servertest.db
│   └── logs/              # DebugLog tailer (incremental + rotation) for SSE
├── modules/               # one folder per logical service (routes + service)
│   ├── auth/ server/ players/ whitelist/ settings/ sandbox/
│   ├── mods/ logs/ console/ admin/ activity/ system/
├── plugins/
│   └── auth.ts            # session/user attach, CSRF, requireAuth/requireRole
└── db/
    └── index.ts           # panel SQLite (users, sessions, audit, scheduled_ops)
```

## Request lifecycle

1. `onRequest` — attach session/user from the signed cookie; enforce CSRF + origin
   on unsafe methods for `/api/*`.
2. route `preHandler` — `requireAuth` / `requireRole(min)` (server-side authz).
3. handler — validate input (zod), call the relevant integration, record audit.
4. `setErrorHandler` — map `ApiError`/`ZodError`/rate-limit to the JSON error model;
   never leak stack traces.

## Runtime abstraction (usable with and without AMP)

Lifecycle + metrics go through a generic `ServerRuntimeAdapter`
(`getStatus`, `getMetrics`, `start`, `stop`, `restart`, optional `update`,
`capabilities`). The adapter is chosen by `PZ_RUNTIME`:

- `amp` (default) — `AmpRuntimeAdapter` wraps the existing AMP integration
  (HTTP API, or `ampinstmgr` + `/proc`). Full lifecycle. `durableServerSettings:
  false` because AMP regenerates `servertest.ini` on restart.
- `standalone` — `StandaloneRuntimeAdapter` reads status/metrics from `/proc`
  and reports `lifecycle: false`; lifecycle calls fail with `NOT_SUPPORTED`
  (501). For PZ started by systemd/docker/a script/by hand. `durableServerSettings:
  true` (nothing regenerates the ini).

No business or shared module imports AMP, `ampinstmgr`, AMP instance names, or
AMP types — only `runtime/amp.adapter.ts` does. The runtime facade applies the
generic transitional-state overlay and gates lifecycle by capability. A future
`systemd`/`docker` adapter only needs to implement the interface and register in
`runtime/index.ts`. Capabilities are surfaced at `GET /api/system/connections`.

## RCON mutation results

Mutations never report a blind `{ ok: true }`. `resolveMutation` returns
`{ accepted, confirmed, confirmation }`: `accepted` is parsed from the RCON reply
(known Build 42 rejection strings → `accepted:false`), and `confirmed` is verified
against authoritative state — the players list (kick), or the read-only
`servertest.db` (ban, access level, whitelist) with bounded retries. Commands with
no queryable state (powers, item, XP, vehicle) are honestly `unavailable`.

## Integration design

- **RCON** keeps a single reusable connection and **serializes** commands through
  a queue, so a burst of dashboard polls doesn't open dozens of sockets. Commands
  are built only from typed, allowlisted templates; arguments are validated and
  quote/control-char-rejected. The password stays in the module and is never
  logged.
- **AMP** prefers the official HTTP API (login/session/relogin) when credentials
  are configured; otherwise lifecycle uses `ampinstmgr` (run as the AMP user) and
  metrics come from `/proc` of the tracked Java process. The process is never
  killed or spawned directly.
- **Files** are parsed with structure-preserving parsers and written with
  backup + atomic replace (temp file → fsync → rename), with retention and
  rollback. Sandbox writes re-parse the result before committing.
- **Status aggregation** maps AMP instance state + RCON readiness to the frontend
  status (`online` only when the process is up *and* RCON answers), and overlays
  transitional states from the operation lock.

## State that is NOT faked

- `serverApi.tick()` / `getHistorySync()` in the frontend adapter return the last
  values fetched from the backend; they no longer simulate the server.
- Resource history is sampled server-side into a bounded in-memory ring buffer.
- The audit log is authoritative in the panel database; the frontend only reads it.
- Logs are real DebugLog lines (tail + SSE), not generated.
