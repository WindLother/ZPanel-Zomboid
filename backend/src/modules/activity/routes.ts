import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth';
import { list } from './service';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activity', { preHandler: requireAuth }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return list(limit);
  });
}
