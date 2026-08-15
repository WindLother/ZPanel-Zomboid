import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Authorization + behavior matrix for the two configuration WRITE endpoints:
 *
 *   PUT /api/settings   admin 200 · moderator 200 · readonly 403 · unauth 401
 *   PUT /api/sandbox    admin 200 · moderator 200 · readonly 403 · unauth 401
 *
 * Moderators may edit Server Settings and Sandbox Settings (AGENTS.md §10).
 * That grant is deliberately narrow: it must not loosen validation, must not
 * bypass the backup/atomic pipeline, and must not leak into lifecycle control
 * (see route-authz.test.ts for the negative matrix).
 *
 * The suite runs against ISOLATED TEMPORARY COPIES of the test fixtures — it
 * never touches a real Project Zomboid server's files.
 */

const TMP = '/tmp/zpanel-test/config-write-authz';
const SERVER_DIR = path.join(TMP, 'Zomboid', 'Server');

// Point the panel DB and the PZ server dir at this suite's own scratch space
// BEFORE any app/db/paths import reads them.
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SERVER_DIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures/servertest.ini'), path.join(SERVER_DIR, 'servertest.ini'));
fs.copyFileSync(
  path.join(__dirname, 'fixtures/servertest_SandboxVars.lua'),
  path.join(SERVER_DIR, 'servertest_SandboxVars.lua'),
);
process.env.PANEL_DB_PATH = path.join(TMP, 'panel.db');
process.env.PZ_SERVER_DIR = SERVER_DIR;
process.env.PZ_SERVER_NAME = 'servertest';

const INI = path.join(SERVER_DIR, 'servertest.ini');
const SANDBOX = path.join(SERVER_DIR, 'servertest_SandboxVars.lua');

const ORIGIN = 'http://localhost:8095';
const PW = { admin: 'BossPassword12', mod: 'ModPassword12', ro: 'ReadonlyPass12' };

let app: FastifyInstance;
let db: any;
let auth: any;

function inject(method: string, url: string, opts: { cookie?: string; csrf?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  if (opts.payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method: method as any, url, headers, payload: opts.payload as any });
}

let loginSeq = 0;
async function login(username: string, password: string) {
  loginSeq += 1; // unique client IP per login (login is rate-limited 8/min/IP)
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-forwarded-for': `10.9.${(loginSeq >> 8) & 255}.${loginSeq & 255}`,
    },
    payload: { username, password },
  });
  const body = res.statusCode === 200 ? res.json() : null;
  return {
    status: res.statusCode,
    cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    csrf: body?.csrfToken as string | undefined,
  };
}

const iniValue = (key: string): string | undefined =>
  fs
    .readFileSync(INI, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`))
    ?.slice(key.length + 1);

/** The full groups payload the browser sends, with one field overridden. */
async function settingsPayloadWith(cookie: string, key: string, value: unknown) {
  const groups = (await inject('GET', '/api/settings', { cookie })).json() as Array<{
    fields: Array<{ key: string; value: unknown }>;
  }>;
  for (const g of groups) for (const f of g.fields) if (f.key === key) f.value = value;
  return groups;
}

beforeAll(async () => {
  db = (await import('../src/db')).db;
  auth = await import('../src/modules/auth/service');
  app = await (await import('../src/app')).buildApp();
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM audit').run();
  await auth.createUser('boss', PW.admin, 'admin');
  await auth.createUser('mod1', PW.mod, 'moderator');
  await auth.createUser('ro1', PW.ro, 'readonly');
});

describe('PUT /api/settings authorization matrix', () => {
  it('admin -> 200 and the value lands in the ini', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 41);
    const res = await inject('PUT', '/api/settings', { cookie, csrf, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toContain('MaxPlayers');
    expect(iniValue('MaxPlayers')).toBe('41');
  });

  it('moderator -> 200 and the value lands in the ini', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 42);
    const res = await inject('PUT', '/api/settings', { cookie, csrf, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(true);
    expect(iniValue('MaxPlayers')).toBe('42');
  });

  it('readonly -> 403 and the file is untouched', async () => {
    const before = fs.readFileSync(INI, 'utf8');
    const ro = await login('ro1', PW.ro);
    const payload = await settingsPayloadWith(ro.cookie, 'MaxPlayers', 99);
    const res = await inject('PUT', '/api/settings', { cookie: ro.cookie, csrf: ro.csrf, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(fs.readFileSync(INI, 'utf8')).toBe(before);
  });

  it('unauthenticated -> 401 and the file is untouched', async () => {
    const before = fs.readFileSync(INI, 'utf8');
    const res = await inject('PUT', '/api/settings', { payload: [] });
    expect(res.statusCode).toBe(401);
    expect(fs.readFileSync(INI, 'utf8')).toBe(before);
  });

  it('readonly may still READ settings (403 is about writing only)', async () => {
    const { cookie } = await login('ro1', PW.ro);
    const res = await inject('GET', '/api/settings', { cookie });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('PUT /api/sandbox authorization matrix', () => {
  it('admin -> 200 and the value lands in SandboxVars.lua', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    const res = await inject('PUT', '/api/sandbox', { cookie, csrf, payload: { FoodLootNew: 2.5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toContain('FoodLootNew');
    expect(fs.readFileSync(SANDBOX, 'utf8')).toMatch(/FoodLootNew\s*=\s*2\.5/);
  });

  it('moderator -> 200 and the value lands in SandboxVars.lua', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const res = await inject('PUT', '/api/sandbox', { cookie, csrf, payload: { FoodLootNew: 3.5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved).toBe(true);
    expect(fs.readFileSync(SANDBOX, 'utf8')).toMatch(/FoodLootNew\s*=\s*3\.5/);
  });

  it('readonly -> 403 and the file is untouched', async () => {
    const before = fs.readFileSync(SANDBOX, 'utf8');
    const ro = await login('ro1', PW.ro);
    const res = await inject('PUT', '/api/sandbox', { cookie: ro.cookie, csrf: ro.csrf, payload: { FoodLootNew: 9 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(fs.readFileSync(SANDBOX, 'utf8')).toBe(before);
  });

  it('unauthenticated -> 401 and the file is untouched', async () => {
    const before = fs.readFileSync(SANDBOX, 'utf8');
    const res = await inject('PUT', '/api/sandbox', { payload: { FoodLootNew: 9 } });
    expect(res.statusCode).toBe(401);
    expect(fs.readFileSync(SANDBOX, 'utf8')).toBe(before);
  });

  it('readonly may still READ sandbox settings', async () => {
    const { cookie } = await login('ro1', PW.ro);
    const res = await inject('GET', '/api/sandbox', { cookie });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('the moderator grant does NOT loosen the write pipeline', () => {
  it('backend validation still rejects an out-of-bounds sandbox value from a moderator', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const before = fs.readFileSync(SANDBOX, 'utf8');
    // Zombies is an enum (1..4 in PZ's own legend) — 99 is not a valid selection.
    const res = await inject('PUT', '/api/sandbox', { cookie, csrf, payload: { Zombies: 99 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(fs.readFileSync(SANDBOX, 'utf8')).toBe(before);
  });

  it('settings writes from a moderator stay on the allowlist (arbitrary ini keys are ignored)', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const res = await inject('PUT', '/api/settings', {
      cookie,
      csrf,
      payload: { NotARealSetting: 'x', '../../etc/passwd': 'x', ServerConfigInjection: 'y' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toEqual([]); // nothing off-schema is ever written
    const ini = fs.readFileSync(INI, 'utf8');
    expect(ini).not.toContain('NotARealSetting');
    expect(ini).not.toContain('etc/passwd');
  });

  it('a moderator save still produces a timestamped backup before the atomic write', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 44);
    expect((await inject('PUT', '/api/settings', { cookie, csrf, payload })).statusCode).toBe(200);
    const backups = fs.readdirSync(path.join(SERVER_DIR, '.zpanel-backups'));
    expect(backups.some((f) => f.startsWith('servertest.ini'))).toBe(true);
  });

  it('a moderator sandbox save preserves unknown/mod-added content byte-for-byte', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const before = fs.readFileSync(SANDBOX, 'utf8');
    expect((await inject('PUT', '/api/sandbox', { cookie, csrf, payload: { FoodLootNew: 1.5 } })).statusCode).toBe(200);
    const after = fs.readFileSync(SANDBOX, 'utf8');
    expect(after.split('\n').length).toBe(before.split('\n').length);
    // exactly one line differs: the one we changed
    const diff = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
    expect(diff.length).toBe(1);
    expect(diff[0]).toMatch(/FoodLootNew/);
  });

  it('saving settings never triggers a lifecycle operation — it only reports restartRequired', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    // ServerWelcomeMessage is a restart-required key in the schema.
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 45);
    const res = await inject('PUT', '/api/settings', { cookie, csrf, payload });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().restartRequired).toBe('boolean');
    // no lifecycle op was scheduled as a side effect of the save
    expect((await inject('GET', '/api/server/scheduled', { cookie })).json()).toEqual([]);
  });
});

describe('audit attribution: a moderator write is recorded as the MODERATOR', () => {
  it('records actorName/actorRole of the authenticated user, visible to the admin', async () => {
    const mod = await login('mod1', PW.mod);
    const payload = await settingsPayloadWith(mod.cookie, 'MaxPlayers', 46);
    expect((await inject('PUT', '/api/settings', { cookie: mod.cookie, csrf: mod.csrf, payload })).statusCode).toBe(200);
    expect((await inject('PUT', '/api/sandbox', { cookie: mod.cookie, csrf: mod.csrf, payload: { FoodLootNew: 2 } })).statusCode).toBe(200);

    // The moderator still cannot READ the trail...
    expect((await inject('GET', '/api/activity', { cookie: mod.cookie })).statusCode).toBe(403);

    // ...but the admin sees both writes attributed to the moderator, not to admin.
    const adm = await login('boss', PW.admin);
    const res = await inject('GET', '/api/activity', { cookie: adm.cookie });
    expect(res.statusCode).toBe(200);
    const events = res.json() as Array<{ actorName: string; actorRole: string | null; action: string; success: boolean }>;
    for (const action of ['settings.save', 'sandbox.save']) {
      const ev = events.find((e) => e.action === action);
      expect(ev, `${action} must be audited`).toBeTruthy();
      expect(ev!.actorName).toBe('mod1');
      expect(ev!.actorRole).toBe('moderator');
      expect(ev!.success).toBe(true);
    }
  });

  it('an admin write is attributed to the admin (roles are not conflated)', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 47);
    expect((await inject('PUT', '/api/settings', { cookie, csrf, payload })).statusCode).toBe(200);
    const events = (await inject('GET', '/api/activity', { cookie })).json() as Array<{
      actorName: string;
      actorRole: string | null;
      action: string;
    }>;
    const ev = events.find((e) => e.action === 'settings.save');
    expect(ev!.actorName).toBe('boss');
    expect(ev!.actorRole).toBe('admin');
  });

  it('audit details never carry secret ini values', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    const payload = await settingsPayloadWith(cookie, 'MaxPlayers', 48);
    await inject('PUT', '/api/settings', { cookie, csrf, payload });
    const rows = db.prepare('SELECT details FROM audit WHERE action = ?').all('settings.save') as Array<{ details: string | null }>;
    for (const r of rows) {
      expect(r.details ?? '').not.toMatch(/password/i);
      expect(r.details ?? '').not.toMatch(/RCONPassword/);
    }
  });
});
