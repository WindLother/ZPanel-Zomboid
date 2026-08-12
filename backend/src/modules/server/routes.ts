import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import { broadcastSchema } from '../../shared/validation';
import * as audit from '../activity/service';
import { getOverview, metricsHistory, saveWorld, broadcast } from './service';
import * as lifecycle from './lifecycle';

const restartBody = z.object({
  delayMinutes: z.coerce.number().int().min(0).max(60).default(0),
  broadcast: z.string().max(400).optional(),
});

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/server', { preHandler: requireAuth }, async () => getOverview());

  app.get('/api/server/history', { preHandler: requireAuth }, async () => metricsHistory.list());

  app.post('/api/server/save', { preHandler: requireRole('moderator') }, async (req) => {
    const result = await saveWorld();
    audit.record({ ...actor(req), action: 'server.save', success: result.ok, details: { durationMs: result.durationMs } });
    return result;
  });

  app.post('/api/server/broadcast', { preHandler: requireRole('moderator') }, async (req) => {
    const { message } = z.object({ message: broadcastSchema }).parse(req.body);
    const result = await broadcast(message);
    audit.record({ ...actor(req), action: 'server.broadcast', success: true, details: { message } });
    return result;
  });

  app.post('/api/server/start', { preHandler: requireRole('admin') }, async (req) => {
    await lifecycle.start(actor(req));
    return { ok: true };
  });

  app.post('/api/server/stop', { preHandler: requireRole('admin') }, async (req) => {
    const body = z.object({ broadcast: z.string().max(400).optional() }).parse(req.body ?? {});
    await lifecycle.stop(actor(req), { broadcast: body.broadcast });
    return { ok: true };
  });

  // Restart (immediate or scheduled) is a MODERATOR operation: it brings the
  // server back on its own. Start/stop/update remain admin-only because they
  // leave the server down (or change installed content).
  app.post('/api/server/restart', { preHandler: requireRole('moderator') }, async (req) => {
    const body = restartBody.parse(req.body ?? {});
    if (body.delayMinutes > 0) {
      const op = lifecycle.scheduleRestart(actor(req), body.delayMinutes, body.broadcast);
      return { scheduled: op };
    }
    await lifecycle.restart(actor(req), { broadcast: body.broadcast });
    return { ok: true };
  });

  app.post('/api/server/update', { preHandler: requireRole('admin') }, async (req) => {
    await lifecycle.update(actor(req));
    return { ok: true };
  });

  app.get('/api/server/scheduled', { preHandler: requireAuth }, async () => lifecycle.listScheduled());

  // Moderators can schedule a delayed restart, so they must be able to cancel
  // the countdown they started.
  app.delete('/api/server/scheduled/:id', { preHandler: requireRole('moderator') }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const ok = lifecycle.cancelScheduled(id);
    if (ok) audit.record({ ...actor(req), action: 'server.restart.cancel', target: id, success: true });
    return { ok };
  });
}
