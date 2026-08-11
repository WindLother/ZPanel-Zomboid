import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/db';
import { createUser } from '../src/modules/auth/service';

/**
 * Regression test for the console privilege-escalation defect: the server
 * console exposes admin-level RCON commands (setaccesslevel, additem, addxp,
 * adduser, …), so it must be an ADMIN capability. A moderator must NOT be able
 * to reach it — otherwise they could self-promote via `setaccesslevel`.
 *
 * The admin case uses an unknown command so authorization passes but the
 * allowlist rejects it (400) BEFORE any RCON connection is attempted — the test
 * never touches a real server.
 */

const ORIGIN = 'http://localhost:8095';

async function login(app: FastifyInstance, username: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: { username, password },
  });
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = res.json().csrfToken as string;
  return { cookie, csrf, status: res.statusCode };
}

describe('console authorization (admin-only)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    db.prepare('DELETE FROM users WHERE username IN (?, ?)').run('cauthz_mod', 'cauthz_admin');
    await createUser('cauthz_mod', 'password-mod-123', 'moderator');
    await createUser('cauthz_admin', 'password-admin-123', 'admin');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.prepare('DELETE FROM users WHERE username IN (?, ?)').run('cauthz_mod', 'cauthz_admin');
  });

  it('rejects a moderator from executing console commands (403)', async () => {
    const { cookie, csrf } = await login(app, 'cauthz_mod', 'password-mod-123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/console/command',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { command: 'setaccesslevel "cauthz_mod" "Admin"' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('rejects a moderator from reading the console buffer (403)', async () => {
    const { cookie } = await login(app, 'cauthz_mod', 'password-mod-123');
    const res = await app.inject({ method: 'GET', url: '/api/console', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('allows an admin past authorization (validation, not 403)', async () => {
    const { cookie, csrf } = await login(app, 'cauthz_admin', 'password-admin-123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/console/command',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: { command: 'definitely_not_a_real_command' },
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(400); // passed authz; rejected by the allowlist
  });

  it('rejects unauthenticated console access (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/console' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a state-changing console POST without a CSRF token (403)', async () => {
    const { cookie } = await login(app, 'cauthz_admin', 'password-admin-123');
    const res = await app.inject({
      method: 'POST',
      url: '/api/console/command',
      headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
      payload: { command: 'players' },
    });
    expect(res.statusCode).toBe(403); // CSRF token missing
  });
});
