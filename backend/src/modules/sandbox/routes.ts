import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import * as audit from '../activity/service';
import { getSandbox, saveSandbox } from './service';

export async function sandboxRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sandbox', { preHandler: requireAuth }, async () => getSandbox());

  // SandboxVars WRITES are admin + moderator (AGENTS.md §10). requireRole is a
  // minimum-rank guard: moderator and admin pass, readonly gets 403, anonymous
  // gets 401. The write still goes through the unchanged safe pipeline —
  // schema validation with PZ's own bounds, in-place patching, backup + atomic
  // write, unknown/mod-added sections preserved.
  app.put('/api/sandbox', { preHandler: requireRole('moderator') }, async (req) => {
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
