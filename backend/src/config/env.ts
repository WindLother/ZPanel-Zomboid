import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Minimal .env loader (avoids a dotenv dependency). Only sets keys that are not
 * already present in the real environment, so container/systemd env wins.
 */
function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8095),
  PANEL_ORIGINS: z.string().default('http://localhost:8095'),
  COOKIE_SECURE: bool(false),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 chars').optional(),

  PZ_SERVER_NAME: z.string().default('servertest'),
  PZ_SERVER_DIR: z.string(),
  PZ_ZOMBOID_DIR: z.string().optional(),
  // Optional override for the Steam Workshop content dir (content/108600). Needed
  // when the server install is separate from the Zomboid data dir (standalone
  // layout). Falls back to a path derived from PZ_ZOMBOID_DIR when unset.
  PZ_WORKSHOP_DIR: z.string().optional(),
  // Optional override for the PZ server install dir (the one holding
  // ProjectZomboid64.json + steamapps/). Used to read the authoritative
  // configured JVM heap. Derived from PZ_WORKSHOP_DIR / PZ_ZOMBOID_DIR if unset.
  PZ_INSTALL_DIR: z.string().optional(),

  PZ_RCON_HOST: z.string().default('127.0.0.1'),
  PZ_RCON_PORT: z.coerce.number().int().positive().default(27015),
  PZ_RCON_PASSWORD: z.string().optional(),

  // Which server-runtime adapter to use.
  //   standalone (default) - assumes nothing: metrics via /proc, lifecycle is
  //                          honestly unsupported. Works on any host.
  //   systemd              - recommended for production: controls one fixed unit.
  //   amp                  - optional, for servers managed by CubeCoders AMP.
  // The default is deliberately the adapter that needs no extra configuration
  // and can never act on a service the operator did not opt into.
  PZ_RUNTIME: z.enum(['amp', 'standalone', 'systemd', 'none', 'custom']).default('standalone'),
  // Fixed systemd unit the SystemdRuntimeAdapter controls. Server-side config
  // only — NEVER derived from a request. Verbs are an internal allowlist.
  SYSTEMD_UNIT: z.string().default('project-zomboid-zpanel.service'),

  AMP_BASE_URL: z.string().optional(),
  AMP_USERNAME: z.string().optional(),
  AMP_PASSWORD: z.string().optional(),
  AMP_INSTANCE_NAME: z.string().optional(),
  AMP_INSTANCE_ID: z.string().optional(),
  AMP_SYSTEM_USER: z.string().default('amp'),
  AMP_ALLOW_CLI: bool(true),

  PANEL_DB_PATH: z.string().default('./data/panel.db'),
  METRICS_SAMPLE_MS: z.coerce.number().int().positive().default(5000),
  METRICS_HISTORY_POINTS: z.coerce.number().int().positive().default(120),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
   
  console.error('Invalid environment configuration:\n' + parsed.error.toString());
  process.exit(1);
}

const raw = parsed.data;

// A random per-process secret is acceptable for dev but means sessions do not
// survive restarts. Require an explicit secret in production.
let sessionSecret = raw.SESSION_SECRET;
if (!sessionSecret) {
  if (raw.NODE_ENV === 'production') {
     
    console.error('SESSION_SECRET is required in production.');
    process.exit(1);
  }
  sessionSecret = require('node:crypto').randomBytes(48).toString('base64url');
}

export const env = {
  ...raw,
  SESSION_SECRET: sessionSecret,
  PZ_ZOMBOID_DIR: raw.PZ_ZOMBOID_DIR ?? path.dirname(raw.PZ_SERVER_DIR),
  panelOrigins: raw.PANEL_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  ampConfigured: Boolean(raw.AMP_BASE_URL && raw.AMP_USERNAME && raw.AMP_PASSWORD),
  isProd: raw.NODE_ENV === 'production',
};

export type Env = typeof env;
