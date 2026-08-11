import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env';
import { ApiError } from './shared/errors';
import { logger } from './shared/logger';
import { registerAuth } from './plugins/auth';
import { authRoutes } from './modules/auth/routes';
import { usersRoutes } from './modules/users/routes';
import { serverRoutes } from './modules/server/routes';
import { playersRoutes } from './modules/players/routes';
import { whitelistRoutes } from './modules/whitelist/routes';
import { settingsRoutes } from './modules/settings/routes';
import { sandboxRoutes } from './modules/sandbox/routes';
import { modsRoutes } from './modules/mods/routes';
import { logsRoutes } from './modules/logs/routes';
import { consoleRoutes } from './modules/console/routes';
import { adminRoutes } from './modules/admin/routes';
import { activityRoutes } from './modules/activity/routes';
import { systemRoutes } from './modules/system/routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true, // behind a reverse proxy; use X-Forwarded-For for req.ip
    bodyLimit: 256 * 1024,
    disableRequestLogging: env.isProd ? false : true,
    // Long-lived connections (the SSE log stream) otherwise keep app.close()
    // waiting forever on shutdown, causing systemd to fall back to SIGKILL.
    // Force-close lingering connections so graceful shutdown actually completes.
    forceCloseConnections: true,
  }) as unknown as FastifyInstance;

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(cors, {
    origin: env.panelOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
  });

  await app.register(helmet, {
    // The existing frontend uses inline styles and external Google Fonts; the
    // reverse proxy owns CSP for the HTML. We keep the other hardening headers.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  });

  // Session/auth/CSRF hooks + guards.
  registerAuth(app);

  // Consistent error model; never leak stack traces to the browser.
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(error.toPayload());
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'INVALID_INPUT', message: 'Validation failed.', details: error.flatten().fieldErrors },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}.` } });
  });

  // API routes.
  await app.register(authRoutes);
  await app.register(usersRoutes);
  await app.register(serverRoutes);
  await app.register(playersRoutes);
  await app.register(whitelistRoutes);
  await app.register(settingsRoutes);
  await app.register(sandboxRoutes);
  await app.register(modsRoutes);
  await app.register(logsRoutes);
  await app.register(consoleRoutes);
  await app.register(adminRoutes);
  await app.register(activityRoutes);
  await app.register(systemRoutes);

  // Optional static hosting of the panel for single-host setups. In production
  // a reverse proxy typically serves the static frontend and proxies /api here.
  const frontendDir = process.env.FRONTEND_DIR;
  if (frontendDir) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, { root: path.resolve(frontendDir), prefix: '/' });
    logger.info({ frontendDir }, 'serving frontend statically');
  }

  return app;
}
