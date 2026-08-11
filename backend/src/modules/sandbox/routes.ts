import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import * as audit from '../activity/service';
import { getSandbox, saveSandbox } from './service';

export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sandbox', { preHandler: requireAuth }, async () => getSandbox());

  app.put('/api/sandbox', { preHandler: requireRole('admin') }, async (req) => {
    try {
      const result = await saveSandbox(req.body);
      audit.record({ ...actor(req), action: 'sandbox.save', success: true, details: { applied: result.applied } });
      return result;
    } catch (e) {
      audit.record({ ...actor(req), action: 'sandbox.save', success: false });
      throw e;
    }
  });
}
