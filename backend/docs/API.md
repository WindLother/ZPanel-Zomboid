# API reference

Base: same origin as the panel. All bodies are JSON. State-changing requests need
the session cookie and `x-csrf-token`.

## Error model

```json
{ "error": { "code": "RCON_UNAVAILABLE", "message": "…", "details": { } } }
```

Codes: `INVALID_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` / `OPERATION_IN_PROGRESS` / `SERVER_OFFLINE` (409),
`RATE_LIMITED` (429), `NOT_SUPPORTED` (501), `RCON_UNAVAILABLE` /
`AMP_UNAVAILABLE` (503), `CONFIG_WRITE_FAILED` / `INTERNAL` (500),
`PZ_RESPONSE_INVALID` (502). `NOT_SUPPORTED` is returned when the selected runtime
lacks a capability (e.g. lifecycle on `PZ_RUNTIME=standalone`). Stack traces are
never returned.

## Mutation result model

Player and whitelist mutations return an honest confirmation shape (never a blind
`{ ok: true }`):

```json
{ "accepted": true, "confirmed": false, "confirmation": "unavailable", "message": "…" }
```

- `accepted` — the RCON reply was not a rejection.
- `confirmed` — verified against authoritative state (players list / servertest.db).
- `confirmation` — `verified` | `unconfirmed` | `unavailable` | `rejected`.

Whitelist mutations additionally return the authoritative `{ users, steamIds }`.

## Auth
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | — | `{username,password}` → `{user, csrfToken}` |
| POST | `/api/auth/logout` | auth | |
| GET | `/api/auth/me` | — | `{authenticated, user?, csrfToken?}` |

## Server
| Method | Path | Role |
|---|---|---|
| GET | `/api/server` | auth |
| GET | `/api/server/history` | auth |
| POST | `/api/server/save` | moderator |
| POST | `/api/server/broadcast` | moderator |
| POST | `/api/server/start` \| `/stop` \| `/restart` \| `/update` | admin |
| GET | `/api/server/scheduled` | auth |
| DELETE | `/api/server/scheduled/:id` | admin |

`restart` accepts `{delayMinutes, broadcast?}`; a non-zero delay schedules a restart
(persisted, resumes on boot, cancellable).

## Players
| Method | Path | Role |
|---|---|---|
| GET | `/api/players` , `/api/players/:username` | auth |
| POST | `/api/players/:username/kick` `{reason?}` | moderator |
| POST | `/api/players/:username/ban` `{reason?, banIp?}` | moderator |
| POST | `/api/players/:username/access` `{level}` | admin |
| POST | `/api/players/:username/powers/:power` `{on}` (godmode\|invisible\|noclip) | admin |
| POST | `/api/players/:username/items` `{item, count}` | admin |
| POST | `/api/players/:username/xp` `{skill, amount}` | admin |
| POST | `/api/players/:username/vehicles` `{vehicle}` | admin |

## Whitelist
`GET /api/whitelist`; `POST /api/whitelist/users {username}`;
`DELETE /api/whitelist/users/:username`; `POST /api/whitelist/steamids {steamId}`;
`DELETE /api/whitelist/steamids/:steamId`.

## Settings / Sandbox
`GET/PUT /api/settings`, `GET/PUT /api/sandbox`. Settings PUT returns
`{groups, saved, applied, restartRequired, durableServerSettings}` (the last from
the runtime capability — false for AMP, true for standalone). Sandbox PUT returns
`{categories, saved, applied}`.

## Mods
Workshop-item-centric (a Workshop ID is not a Mod ID; one item may provide many).
- `GET /api/mods` → `WorkshopItem[]` (each has `workshopId`, `modIds[]`, `enabledModIds[]`, `modIdsResolved`, `enabled`, `loadOrder`).
- `POST /api/mods/lookup {workshopId}` → resolves real Mod ID(s) from downloaded
  `mod.info` on disk: `{workshopId, found, modIds, name, author, metadataAvailable}`.
- `POST /api/mods {workshopId, modIds[]}` → add item + selected/entered Mod IDs
  (structured; never a raw `Mods=` string). Dedupes; preserves existing config.
- `DELETE /api/mods/:workshopId` → remove item + only Mod IDs it owns that no other
  item still requires. `DELETE /api/mods/standalone/:modId` for a local Mod ID.
- `POST /api/mods/:workshopId/toggle` (enable/disable = add/remove its Mod IDs from
  `Mods=`, item stays downloaded); `POST /api/mods/:workshopId/move {direction}`.
- `POST /api/mods/check-updates`; `POST /api/mods/update` (pointer to the runtime
  update). Mods logic is Project-Zomboid-centric — no AMP dependency.

## Logs / Console / Admin / Activity / System
- `GET /api/logs?limit=`, `GET /api/logs/stream` (SSE).
- `GET /api/console`, `POST /api/console/command {command}` (allowlisted).
- `GET /api/admin/actions`, `POST /api/admin/actions/:action`.
- `GET /api/activity?limit=`.
- `GET /health` (public), `GET /api/system/connections` (admin).
