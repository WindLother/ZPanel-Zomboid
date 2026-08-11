import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { ApiError, err } from '../shared/errors';
import { getSession, SESSION_COOKIE, type Role, type User, type SessionRecord } from '../modules/auth/service';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: User;
    currentSession?: SessionRecord;
  }
}

const ROLE_RANK: Record<Role, number> = { readonly: 0, moderator: 1, admin: 2 };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Attaches session/user to each request (from the signed session cookie),
 * enforces CSRF on state-changing requests, and exposes `requireAuth` /
 * `requireRole` guards. Authorization always happens server-side; hidden
 * frontend buttons are never trusted.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('currentUser', undefined);
  app.decorateRequest('currentSession', undefined);

  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const session = getSession(unsigned.value);
    if (session) {
      req.currentUser = session.user;
      req.currentSession = session;
    }
  });

  // CSRF + origin enforcement for unsafe methods on the API.
  app.addHook('onRequest', async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    if (req.url === '/api/auth/login') {
      verifyOrigin(req);
      return;
    }
    verifyOrigin(req);
    const token = req.headers['x-csrf-token'];
    if (!req.currentSession) throw err.unauthorized();
    if (typeof token !== 'string' || token !== req.currentSession.csrfSecret) {
      throw new ApiError('FORBIDDEN', 'Invalid or missing CSRF token.');
    }
  });
}

function verifyOrigin(req: FastifyRequest): void {
  const origin = (req.headers.origin as string | undefined) ?? undefined;
  const referer = (req.headers.referer as string | undefined) ?? undefined;
  const source = origin ?? (referer ? new URL(referer).origin : undefined);
  if (!source) {
    // No Origin/Referer on a state-changing request is suspicious for a browser.
    throw new ApiError('FORBIDDEN', 'Missing request origin.');
  }
  if (!env.panelOrigins.includes(source)) {
    throw new ApiError('FORBIDDEN', 'Request origin is not allowed.');
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.currentUser) throw err.unauthorized();
}

export function requireRole(min: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.currentUser) throw err.unauthorized();
    if (ROLE_RANK[req.currentUser.role] < ROLE_RANK[min]) throw err.forbidden();
  };
}

/** Convenience for audit calls that need request context. */
export function actor(req: FastifyRequest): { actorId: number | null; actorName: string; sourceIp: string } {
  return {
    actorId: req.currentUser?.id ?? null,
    actorName: req.currentUser?.username ?? 'anonymous',
    sourceIp: req.ip,
  };
}
