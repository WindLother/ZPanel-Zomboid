import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../plugins/auth';
import { list } from './service';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  // VIEWING the audit trail is admin-only. Recording is unaffected: every
  // moderator/admin mutation still writes audit rows via audit.record() in its
  // own route — admins see those entries here.
  app.get('/api/activity', { preHandler: requireRole('admin') }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return list(limit);
  });
}
