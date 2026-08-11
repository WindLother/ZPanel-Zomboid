import type { FastifyInstance } from 'fastify';
import { operationLock } from '../../shared/lock';
import { err } from '../../shared/errors';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import * as audit from '../activity/service';
import { getSettings, saveSettings } from './service';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', { preHandler: requireAuth }, async () => getSettings());

  app.put('/api/settings', { preHandler: requireRole('admin') }, async (req) => {
    // Serialize against lifecycle ops: never write config during a start/stop/update.
    return operationLock.run('config-write', actor(req).actorName, async () => {
      try {
        const result = await saveSettings(req.body);
        audit.record({ ...actor(req), action: 'settings.save', success: true, details: { applied: result.applied } });
        return result;
      } catch (e) {
        audit.record({ ...actor(req), action: 'settings.save', success: false });
        throw e;
      }
    }).catch((e) => {
      if (e instanceof Error && (e as { code?: string }).code === 'OPERATION_IN_PROGRESS') throw err.busy();
      throw e;
    });
  });
}
