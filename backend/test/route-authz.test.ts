import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Isolate this suite's panel DB BEFORE any app/db import.
process.env.PANEL_DB_PATH = '/tmp/zpanel-test/route-authz-suite.db';

const ORIGIN = 'http://localhost:8095';
const PW = { admin: 'BossPassword12', mod: 'ModPassword12', ro: 'ReadonlyPass12' };

let app: FastifyInstance;
let db: any;
let auth: any;
let audit: any;

function inject(method: string, url: string, opts: { cookie?: string; csrf?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  if (opts.payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method: method as any, url, headers, payload: opts.payload as any });
}

let loginSeq = 0;
async function login(username: string, password: string) {
  loginSeq += 1; // unique client IP per login so the per-IP login rate limit never triggers
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `10.8.${(loginSeq >> 8) & 255}.${loginSeq & 255}` },
    payload: { username, password },
  });
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const body = res.statusCode === 200 ? res.json() : null;
  return { status: res.statusCode, cookie, csrf: body?.csrfToken as string | undefined };
}

beforeAll(async () => {
  const fs = await import('node:fs');
  fs.mkdirSync('/tmp/zpanel-test', { recursive: true });
  for (const s of ['', '-wal', '-shm']) fs.rmSync('/tmp/zpanel-test/route-authz-suite.db' + s, { force: true });
  db = (await import('../src/db')).db;
  auth = await import('../src/modules/auth/service');
  audit = await import('../src/modules/activity/service');
  app = await (await import('../src/app')).buildApp();
  await app.ready();
});
afterAll(async () => app?.close());
beforeEach(async () => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM audit').run();
  await auth.createUser('boss', PW.admin, 'admin');
  await auth.createUser('mod1', PW.mod, 'moderator');
  await auth.createUser('ro1', PW.ro, 'readonly');
});

// Regression for the RBAC bug: the Activity Log (audit trail) is admin-only.
describe('GET /api/activity authorization matrix', () => {
  it('admin -> 200 with the audit list', async () => {
    const { cookie } = await login('boss', PW.admin);
    const res = await inject('GET', '/api/activity', { cookie });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('moderator -> 403 (cannot view the audit trail)', async () => {
    const { cookie } = await login('mod1', PW.mod);
    expect((await inject('GET', '/api/activity', { cookie })).statusCode).toBe(403);
  });

  it('readonly -> 403', async () => {
    const { cookie } = await login('ro1', PW.ro);
    expect((await inject('GET', '/api/activity', { cookie })).statusCode).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    expect((await inject('GET', '/api/activity')).statusCode).toBe(401);
  });
});

// Lifecycle split: restart (self-recovering) is a moderator operation; start/
// stop/update leave the server down or change content, so they stay admin-only.
describe('server lifecycle authorization matrix', () => {
  it('moderator may schedule/cancel a restart but NOT start/stop/update', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    // A delayed restart only schedules an op — it does not touch the live server.
    const scheduled = await inject('POST', '/api/server/restart', { cookie, csrf, payload: { delayMinutes: 5 } });
    expect(scheduled.statusCode).toBe(200);
    const id = scheduled.json().scheduled?.id as string;
    expect(id).toBeTruthy();
    expect((await inject('DELETE', `/api/server/scheduled/${id}`, { cookie, csrf })).statusCode).toBe(200);

    for (const url of ['/api/server/start', '/api/server/stop', '/api/server/update']) {
      expect((await inject('POST', url, { cookie, csrf, payload: {} })).statusCode, url).toBe(403);
    }
  });

  it('readonly may not restart, and unauthenticated is rejected', async () => {
    const ro = await login('ro1', PW.ro);
    expect((await inject('POST', '/api/server/restart', { cookie: ro.cookie, csrf: ro.csrf, payload: { delayMinutes: 5 } })).statusCode).toBe(403);
    expect([401, 403]).toContain((await inject('POST', '/api/server/restart', { payload: { delayMinutes: 5 } })).statusCode);
  });

  it('admin retains full lifecycle access (restart scheduling still works)', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    const res = await inject('POST', '/api/server/restart', { cookie, csrf, payload: { delayMinutes: 5 } });
    expect(res.statusCode).toBe(200);
    const id = res.json().scheduled?.id as string;
    expect((await inject('DELETE', `/api/server/scheduled/${id}`, { cookie, csrf })).statusCode).toBe(200);
  });
});

// Mod curation: moderators may add/remove/enable/disable Workshop items (and
// look them up). Load-order moves and content updates stay admin-only.
describe('mods authorization matrix', () => {
  // Authorization is the subject here, so assert on the GUARD: a 403 means the
  // role was rejected; anything else means the guard let it through (the
  // handler then works against the isolated test PZ dir).
  const MOD_ROUTES: Array<[string, string, unknown]> = [
    ['POST', '/api/mods/lookup', { workshopId: '123456789' }],
    ['POST', '/api/mods', { workshopId: '123456789', modIds: ['test_mod'] }],
    ['DELETE', '/api/mods/123456789', undefined],
    ['DELETE', '/api/mods/standalone/test_mod', undefined],
    ['POST', '/api/mods/123456789/toggle', {}],
  ];
  const ADMIN_ONLY: Array<[string, string, unknown]> = [
    ['POST', '/api/mods/123456789/move', { direction: 1 }],
    ['POST', '/api/mods/update', {}],
  ];

  it('moderator passes the guard on lookup/add/remove/remove-standalone/toggle', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    for (const [method, url, payload] of MOD_ROUTES) {
      const res = await inject(method, url, { cookie, csrf, payload });
      expect(res.statusCode, `${method} ${url} must not be forbidden for moderator`).not.toBe(403);
    }
  });

  it('moderator is still forbidden from load-order moves and content updates', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    for (const [method, url, payload] of ADMIN_ONLY) {
      expect((await inject(method, url, { cookie, csrf, payload })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('readonly is forbidden from every mod mutation, and may still list mods', async () => {
    const { cookie, csrf } = await login('ro1', PW.ro);
    for (const [method, url, payload] of [...MOD_ROUTES, ...ADMIN_ONLY]) {
      expect((await inject(method, url, { cookie, csrf, payload })).statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await inject('GET', '/api/mods', { cookie })).statusCode).toBe(200);
  });

  it('unauthenticated is rejected on every mod route', async () => {
    for (const [method, url, payload] of [...MOD_ROUTES, ...ADMIN_ONLY]) {
      expect([401, 403], `${method} ${url}`).toContain((await inject(method, url, { payload })).statusCode);
    }
  });

  it('admin retains access to every mod route', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    for (const [method, url, payload] of [...MOD_ROUTES, ...ADMIN_ONLY]) {
      expect((await inject(method, url, { cookie, csrf, payload })).statusCode, `${method} ${url}`).not.toBe(403);
    }
  });
});

/**
 * Blast-radius guard for the "moderators may edit Server/Sandbox Settings"
 * grant: config WRITE access must not spill into any other restricted area.
 * The two config writes themselves are covered by config-write-authz.test.ts.
 */
describe('moderator remains forbidden from every OTHER admin-only capability', () => {
  const ADMIN_ONLY: Array<[string, string, unknown]> = [
    // Server Console
    ['GET', '/api/console', undefined],
    ['POST', '/api/console/command', { command: 'players' }],
    // Activity Log (viewing; recording is unaffected)
    ['GET', '/api/activity', undefined],
    // Panel user management / admin account management
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', { username: 'newmod', password: 'SomePassword12', role: 'admin' }],
    ['PATCH', '/api/users/1', { role: 'admin' }],
    ['POST', '/api/users/1/reset-password', { password: 'SomePassword12' }],
    ['DELETE', '/api/users/1', undefined],
    // System connections / integration secrets
    ['GET', '/api/system/connections', undefined],
    // Lifecycle that leaves the server down or changes installed content
    ['POST', '/api/server/start', {}],
    ['POST', '/api/server/stop', {}],
    ['POST', '/api/server/update', {}],
    // Whitelist mutations + mod load-order/content updates + privileged player actions
    ['POST', '/api/whitelist/users', { username: 'someone' }],
    ['DELETE', '/api/whitelist/users/someone', undefined],
    ['POST', '/api/mods/123456789/move', { direction: 1 }],
    ['POST', '/api/mods/update', {}],
    ['POST', '/api/players/someone/access', { level: 'admin' }],
  ];

  it('every listed admin-only endpoint returns 403 for a moderator', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    for (const [method, url, payload] of ADMIN_ONLY) {
      expect((await inject(method, url, { cookie, csrf, payload })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('readonly is forbidden from all of them too', async () => {
    const { cookie, csrf } = await login('ro1', PW.ro);
    for (const [method, url, payload] of ADMIN_ONLY) {
      expect((await inject(method, url, { cookie, csrf, payload })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('unauthenticated is rejected on all of them', async () => {
    for (const [method, url, payload] of ADMIN_ONLY) {
      expect([401, 403], `${method} ${url}`).toContain((await inject(method, url, { payload })).statusCode);
    }
  });

  // Admin reachability of the read-only members is asserted here; the mutating
  // ones (start/stop/update, console commands, whitelist RCON) are deliberately
  // NOT invoked as admin — that would drive real systemd/RCON side effects from
  // a test run. Their admin path is covered by users.test.ts / console-authz.
  it('admin still reaches the admin-only READ endpoints', async () => {
    const { cookie } = await login('boss', PW.admin);
    for (const url of ['/api/console', '/api/activity', '/api/users', '/api/system/connections']) {
      expect((await inject('GET', url, { cookie })).statusCode, url).not.toBe(403);
    }
  });
});

describe('moderator actions are still AUDITED (view-restriction never disables recording)', () => {
  it('an event recorded for a moderator actor is visible to the admin via the API', async () => {
    // audit.record is exactly what moderator-permitted routes (kick/ban/save/
    // broadcast) call; record one under the moderator's identity.
    const modId = (db.prepare('SELECT id FROM users WHERE username = ?').get('mod1') as { id: number }).id;
    audit.record({ actorId: modId, actorName: 'mod1', action: 'player.kick', target: 'griefer42', details: { reason: 'test' }, success: true, sourceIp: '10.0.0.9' });

    // The moderator still cannot READ the trail...
    const mod = await login('mod1', PW.mod);
    expect((await inject('GET', '/api/activity', { cookie: mod.cookie })).statusCode).toBe(403);

    // ...but the admin sees the moderator's action in it.
    const adm = await login('boss', PW.admin);
    const res = await inject('GET', '/api/activity', { cookie: adm.cookie });
    expect(res.statusCode).toBe(200);
    const events = res.json() as Array<{ actorName: string; action: string; target?: string }>;
    const kick = events.find((e) => e.action === 'player.kick');
    expect(kick).toBeTruthy();
    expect(kick!.actorName).toBe('mod1');
    expect(kick!.target).toBe('griefer42');
  });
});
