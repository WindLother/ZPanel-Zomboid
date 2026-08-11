import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Isolate this suite's panel DB BEFORE any app/db import (which happens
// dynamically in beforeAll). Static imports above must not touch the db.
process.env.PANEL_DB_PATH = '/tmp/zpanel-test/users-suite.db';

const ORIGIN = 'http://localhost:8095';
const PW = { admin: 'BossPassword12', mod: 'ModPassword12', ro: 'ReadonlyPass12' };

let app: FastifyInstance;
let db: any; // dynamically-imported (bound to the isolated DB)
let auth: any;

/** Inject helper: only sends a JSON content-type when there is actually a body. */
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
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `10.9.${(loginSeq >> 8) & 255}.${loginSeq & 255}` },
    payload: { username, password },
  });
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const body = res.statusCode === 200 ? res.json() : null;
  return { status: res.statusCode, cookie, csrf: body?.csrfToken as string | undefined };
}

async function seedBaseline() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM audit').run();
  await auth.createUser('boss', PW.admin, 'admin'); // the single bootstrap admin
  await auth.createUser('mod1', PW.mod, 'moderator');
  await auth.createUser('ro1', PW.ro, 'readonly');
}

function idOf(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

beforeAll(async () => {
  const fs = await import('node:fs');
  fs.mkdirSync('/tmp/zpanel-test', { recursive: true });
  for (const s of ['', '-wal', '-shm']) fs.rmSync('/tmp/zpanel-test/users-suite.db' + s, { force: true });
  db = (await import('../src/db')).db;
  auth = await import('../src/modules/auth/service');
  app = await (await import('../src/app')).buildApp();
  await app.ready();
});
afterAll(async () => app?.close());
beforeEach(seedBaseline);

// --- authorization matrix ----------------------------------------------------
describe('user-management authorization', () => {
  const ENDPOINTS: Array<[string, string, unknown]> = [
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', { username: 'x1234', password: 'Password12', role: 'moderator' }],
    ['PATCH', '/api/users/9999', { role: 'moderator' }],
    ['POST', '/api/users/9999/reset-password', { password: 'Password12' }],
    ['DELETE', '/api/users/9999', undefined],
  ];

  it('unauthenticated -> 401/403 on every user endpoint, never 2xx', async () => {
    for (const [method, url, payload] of ENDPOINTS) {
      const res = await inject(method, url, { payload });
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it('moderator -> 403 on every user-management endpoint', async () => {
    const { cookie, csrf } = await login('mod1', PW.mod);
    for (const [method, url, payload] of ENDPOINTS) {
      const res = await inject(method, url, { cookie, csrf, payload });
      expect(res.statusCode).toBe(403);
    }
  });

  it('read_only -> 403 on every user-management endpoint AND on a mutation', async () => {
    const { cookie, csrf } = await login('ro1', PW.ro);
    for (const [method, url, payload] of ENDPOINTS) {
      const res = await inject(method, url, { cookie, csrf, payload });
      expect(res.statusCode).toBe(403);
    }
    const s = await inject('PUT', '/api/settings', { cookie, csrf, payload: {} });
    expect(s.statusCode).toBe(403);
  });
});

// --- admin capabilities + validation ----------------------------------------
describe('admin user management', () => {
  async function asAdmin() {
    const { cookie, csrf } = await login('boss', PW.admin);
    return (method: string, url: string, payload?: unknown) => inject(method, url, { cookie, csrf, payload });
  }

  it('lists users without any password hash field', async () => {
    const call = await asAdmin();
    const res = await call('GET', '/api/users');
    expect(res.statusCode).toBe(200);
    const users = res.json();
    expect(users.map((u: any) => u.username).sort()).toEqual(['boss', 'mod1', 'ro1']);
    const blob = JSON.stringify(users).toLowerCase();
    expect(blob).not.toContain('passwordhash');
    expect(blob).not.toContain('password_hash');
    expect(blob).not.toContain('$argon2');
  });

  it('creates a user (no hash in response), rejects duplicate/invalid role/weak password', async () => {
    const call = await asAdmin();
    const create = await call('POST', '/api/users', { username: 'bel', password: 'BelPassword12', role: 'moderator' });
    expect(create.statusCode).toBe(200);
    expect(JSON.stringify(create.json())).not.toMatch(/argon2|password_hash|passwordHash/i);
    expect(create.json().role).toBe('moderator');

    expect((await call('POST', '/api/users', { username: 'bel', password: 'BelPassword12', role: 'moderator' })).statusCode).toBe(409);
    expect((await call('POST', '/api/users', { username: 'nope1', password: 'GoodPassword12', role: 'superuser' })).statusCode).toBe(400);
    expect((await call('POST', '/api/users', { username: 'nope2', password: 'short', role: 'moderator' })).statusCode).toBe(400);
    expect((await call('POST', '/api/users', { username: 'nope3', password: 'nodigitsatall', role: 'moderator' })).statusCode).toBe(400);
  });

  it('changes a role (takes effect server-side) and invalidates the target session', async () => {
    const call = await asAdmin();
    await call('POST', '/api/users', { username: 'rcuser', password: 'RcPassword12', role: 'readonly' });
    let rc = await login('rcuser', 'RcPassword12');
    expect((await inject('GET', '/api/users', { cookie: rc.cookie })).statusCode).toBe(403); // readonly
    const patched = await call('PATCH', `/api/users/${idOf('rcuser')}`, { role: 'admin' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().role).toBe('admin');
    // old session invalidated by role change
    expect((await inject('GET', '/api/auth/me', { cookie: rc.cookie })).json().authenticated).toBe(false);
    rc = await login('rcuser', 'RcPassword12');
    expect((await inject('GET', '/api/users', { cookie: rc.cookie })).statusCode).toBe(200); // now admin
  });

  it('resets a password: old credentials stop working, new work, sessions invalidated', async () => {
    const call = await asAdmin();
    await call('POST', '/api/users', { username: 'bel', password: 'OldPassword12', role: 'moderator' });
    const before = await login('bel', 'OldPassword12');
    expect(before.status).toBe(200);
    expect((await call('POST', `/api/users/${idOf('bel')}/reset-password`, { password: 'NewPassword34' })).statusCode).toBe(200);
    expect((await inject('GET', '/api/auth/me', { cookie: before.cookie })).json().authenticated).toBe(false);
    expect((await login('bel', 'OldPassword12')).status).toBe(401);
    expect((await login('bel', 'NewPassword34')).status).toBe(200);
  });

  it('disables a user: cannot log in, existing session invalidated, re-enable restores', async () => {
    const call = await asAdmin();
    await call('POST', '/api/users', { username: 'bel', password: 'BelPassword12', role: 'moderator' });
    const sess = await login('bel', 'BelPassword12');
    const dis = await call('PATCH', `/api/users/${idOf('bel')}`, { active: false });
    expect(dis.statusCode).toBe(200);
    expect(dis.json().active).toBe(false);
    expect((await inject('GET', '/api/auth/me', { cookie: sess.cookie })).json().authenticated).toBe(false);
    expect((await login('bel', 'BelPassword12')).status).toBe(401);
    await call('PATCH', `/api/users/${idOf('bel')}`, { active: true });
    expect((await login('bel', 'BelPassword12')).status).toBe(200);
  });

  it('deletes a user', async () => {
    const call = await asAdmin();
    await call('POST', '/api/users', { username: 'temp', password: 'TempPassword12', role: 'readonly' });
    expect((await call('DELETE', `/api/users/${idOf('temp')}`)).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('temp') as any).n).toBe(0);
  });
});

// --- last-admin protection ---------------------------------------------------
describe('last active admin protection', () => {
  async function admin() {
    const { cookie, csrf } = await login('boss', PW.admin);
    return (method: string, url: string, payload?: unknown) => inject(method, url, { cookie, csrf, payload });
  }

  it('cannot demote / disable / delete the last active admin (boss)', async () => {
    const call = await admin();
    const id = idOf('boss');
    expect((await call('PATCH', `/api/users/${id}`, { role: 'moderator' })).statusCode).toBe(409);
    expect((await call('PATCH', `/api/users/${id}`, { active: false })).statusCode).toBe(409);
    expect((await call('DELETE', `/api/users/${id}`)).statusCode).toBe(409);
    expect(db.prepare("SELECT role, active FROM users WHERE username='boss'").get()).toEqual({ role: 'admin', active: 1 });
  });

  it('allows demoting one admin once a second active admin exists', async () => {
    const call = await admin();
    await call('POST', '/api/users', { username: 'admin2', password: 'Admin2Password12', role: 'admin' });
    expect((await call('PATCH', `/api/users/${idOf('boss')}`, { role: 'moderator' })).statusCode).toBe(200);
    // admin2 is now the last admin -> cannot be deleted
    const a2 = await login('admin2', 'Admin2Password12');
    expect((await inject('DELETE', `/api/users/${idOf('admin2')}`, { cookie: a2.cookie, csrf: a2.csrf })).statusCode).toBe(409);
  });
});

// --- audit contains no password material ------------------------------------
describe('audit contains no password material', () => {
  it('create/reset audit rows never include the plaintext password or a hash', async () => {
    const { cookie, csrf } = await login('boss', PW.admin);
    const call = (method: string, url: string, payload?: unknown) => inject(method, url, { cookie, csrf, payload });
    const secret = 'SuperSecret9999';
    await call('POST', '/api/users', { username: 'bel', password: secret, role: 'moderator' });
    await call('POST', `/api/users/${idOf('bel')}/reset-password`, { password: 'AnotherSecret9' });
    const rows = db.prepare('SELECT action, target, details FROM audit').all() as Array<{ action: string; target: string; details: string | null }>;
    const userRows = rows.filter((r) => r.action.startsWith('user.'));
    expect(userRows.length).toBeGreaterThan(0);
    for (const r of userRows) {
      const blob = JSON.stringify({ target: r.target, details: r.details });
      expect(blob).not.toContain(secret);
      expect(blob).not.toContain('AnotherSecret9');
      expect(blob).not.toMatch(/\$argon2|password_hash|passwordHash/i);
    }
  });
});
