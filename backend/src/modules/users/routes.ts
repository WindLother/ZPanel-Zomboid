import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, actor } from '../../plugins/auth';
import { err } from '../../shared/errors';
import * as audit from '../activity/service';
import {
  listUsers,
  getUser,
  createPanelUser,
  updateUser,
  resetUserPassword,
  deleteUser,
} from './service';

/**
 * Panel user & role management. EVERY endpoint requires the `admin` role — not
 * moderator, not read_only, not merely authenticated. These manage web-panel
 * accounts only and never touch Project Zomboid players/whitelist/RCON. Audit
 * details never contain passwords or password hashes.
 */
const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', { preHandler: requireRole('admin') }, async () => listUsers());

  app.post('/api/users', { preHandler: requireRole('admin') }, async (req) => {
    const body = z.object({ username: z.string(), password: z.string(), role: z.string() }).parse(req.body);
    const user = await createPanelUser(body);
    audit.record({ ...actor(req), action: 'user.create', target: user.username, details: { role: user.role }, success: true });
    return user; // no passwordHash field is ever present
  });

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ role: z.string().optional(), active: z.boolean().optional() }).parse(req.body);
    if (body.role === undefined && body.active === undefined) throw err.invalid('Nothing to update.');

    const before = getUser(id);
    if (!before) throw err.notFound('Panel user not found.');
    const after = await updateUser(id, body);

    if (body.role !== undefined && after.role !== before.role) {
      audit.record({ ...actor(req), action: 'user.roleChange', target: after.username, details: { from: before.role, to: after.role }, success: true });
    }
    if (body.active !== undefined && after.active !== before.active) {
      audit.record({ ...actor(req), action: after.active ? 'user.enable' : 'user.disable', target: after.username, success: true });
    }
    return after;
  });

  app.post('/api/users/:id/reset-password', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const target = getUser(id);
    if (!target) throw err.notFound('Panel user not found.');
    // Resetting one's OWN password keeps the current session and drops the rest.
    const keep = req.currentUser?.id === id ? req.currentSession?.id : undefined;
    await resetUserPassword(id, password, keep);
    audit.record({ ...actor(req), action: 'user.resetPassword', target: target.username, success: true }); // NO password in details
    return { ok: true };
  });

  app.delete('/api/users/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const target = getUser(id);
    if (!target) throw err.notFound('Panel user not found.');
    await deleteUser(id);
    audit.record({ ...actor(req), action: 'user.delete', target: target.username, details: { role: target.role }, success: true });
    return { ok: true };
  });
}
