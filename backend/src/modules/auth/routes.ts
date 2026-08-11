import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { err } from '../../shared/errors';
import { requireAuth, actor } from '../../plugins/auth';
import * as audit from '../activity/service';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  sessionTtlMs,
  verifyLogin,
} from './service';

const cookieOpts = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/',
  signed: true,
  maxAge: Math.floor(sessionTtlMs / 1000),
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { username, password } = z
        .object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })
        .parse(req.body);
      const user = await verifyLogin(username, password);
      if (!user) {
        audit.record({ actorName: username, action: 'auth.login', success: false, sourceIp: req.ip });
        throw err.unauthorized('Invalid username or password.');
      }
      const session = createSession(user.id, req.ip);
      reply.setCookie(SESSION_COOKIE, session.id, cookieOpts);
      audit.record({ actorId: user.id, actorName: user.username, action: 'auth.login', success: true, sourceIp: req.ip });
      return { user, csrfToken: session.csrfSecret };
    },
  );

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    if (req.currentSession) destroySession(req.currentSession.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    audit.record({ ...actor(req), action: 'auth.logout', success: true });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.currentUser || !req.currentSession) return { authenticated: false };
    return { authenticated: true, user: req.currentUser, csrfToken: req.currentSession.csrfSecret };
  });
}
