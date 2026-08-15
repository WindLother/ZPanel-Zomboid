# Deployment

```
browser ──HTTPS──▶ reverse proxy (Caddy/Nginx) ──▶ ZPanel backend (127.0.0.1:8095)
                                                      ├─ localhost RCON :27015
                                                      ├─ AMP API :8083  (or ampinstmgr)
                                                      └─ PZ files + db + logs
```

- The backend binds `127.0.0.1` — it is never exposed publicly. RCON stays
  localhost-only.
- Terminate TLS at the proxy; set `COOKIE_SECURE=true` and `PANEL_ORIGINS` to the
  public panel URL.

## Reverse proxy (Caddy example)

```
panel.example.com {
    encode gzip
    handle /api/*   { reverse_proxy 127.0.0.1:8095 }
    handle /health  { reverse_proxy 127.0.0.1:8095 }
    handle          { root * /srv/zpanel/public; try_files {path} /index.html; file_server }
}
```

`/srv/zpanel/public` holds the static panel: `index.html` (the panel HTML),
`api.js`, `support.js`. Do **not** point the static root at the backend source
directory. (For single-host setups you may instead set `FRONTEND_DIR` and let the
backend serve `public/` — it is confined and blocks path traversal.)

## Least-privilege service user

Run as a dedicated non-root user (e.g. `zpanel`). Grant only what it needs:

- **Read/write** the PZ `Server/` dir (ini, SandboxVars, `.zpanel-backups/`) and
  read the `Logs/` dir — via group membership/ACL with the `amp` group, e.g.
  `setfacl -R -m u:zpanel:rwX .../Zomboid/Server` and `:rX` on `Logs`.
- **Read-only** `db/servertest.db` (`setfacl -m u:zpanel:r ...`).
- **Lifecycle**: a tight sudoers rule, only for the exact command:
  ```
  # AMP runtime only (PZ_RUNTIME=amp). Substitute YOUR instance name.
  zpanel ALL=(amp) NOPASSWD: /usr/bin/ampinstmgr --StartInstance <AMP_INSTANCE_NAME>, \
    /usr/bin/ampinstmgr --StopInstance <AMP_INSTANCE_NAME>, \
    /usr/bin/ampinstmgr --RestartInstance <AMP_INSTANCE_NAME>, \
    /usr/bin/ampinstmgr --UpgradeInstance <AMP_INSTANCE_NAME>
  ```
  (Or configure AMP API credentials and set `AMP_ALLOW_CLI=false` to avoid sudo
  entirely.)

Do **not** grant unrestricted sudo, docker socket access, or a general shell.

## systemd unit (sketch)

```ini
[Service]
User=zpanel
WorkingDirectory=/srv/zpanel/backend
EnvironmentFile=/srv/zpanel/backend/.env
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/zpanel/backend/data <PZ_SERVER_DIR>
```

## Bootstrap

```bash
npm ci && npm run build
npm run seed:admin -- <owner> '<password>' admin
systemctl start zpanel
```

Verify: `GET /health`, then log in and check `GET /api/system/connections`
(`amp`, `rcon`, `filesystem`, `database` should be `ok`).
