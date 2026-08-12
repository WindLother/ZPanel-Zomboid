import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Isolate this suite's panel DB BEFORE any app/db import.
process.env.PANEL_DB_PATH = '/tmp/zpanel-test/activity-suite.db';

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
  for (const s of ['', '-wal', '-shm']) fs.rmSync('/tmp/zpanel-test/activity-suite.db' + s, { force: true });
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
