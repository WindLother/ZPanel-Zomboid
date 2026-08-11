import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, actor } from '../../plugins/auth';
import { rcon } from '../../integrations/rcon/service';
import { err } from '../../shared/errors';
import * as audit from '../activity/service';
import { ADMIN_ACTIONS, resolveAdminAction } from './registry';

/**
 * Admin world tools mapped through a strict registry — the browser sends only an
 * action id, never a command. No generic RCON passthrough.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/actions', { preHandler: requireRole('moderator') }, async () =>
    Object.values(ADMIN_ACTIONS).map((a) => ({ id: a.id, label: a.label, minRole: a.minRole })),
  );

  app.post('/api/admin/actions/:action', { preHandler: requireRole('moderator') }, async (req) => {
    const { action } = z.object({ action: z.string() }).parse(req.params);
    const def = resolveAdminAction(action);
    if (!def) throw err.notFound(`Unknown admin action "${action}".`);
    // Per-action role check (some actions require admin).
    const role = req.currentUser!.role;
    const rank = { readonly: 0, moderator: 1, admin: 2 } as const;
    if (rank[role] < rank[def.minRole]) throw err.forbidden();

    const command = def.build((req.body as Record<string, unknown>) ?? {});
    await rcon.exec(command);
    audit.record({ ...actor(req), action: `admin.${def.id}`, success: true });
    return { ok: true, action: def.id };
  });
}
