import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { paths } from '../../config/paths';
import { requireRole } from '../../plugins/auth';
import { rcon } from '../../integrations/rcon/service';
import { runtime } from '../../integrations/runtime';
import { dbAvailable } from '../../integrations/zomboid-db/players';

/**
 * Health endpoints. `/health` is unauthenticated and reports only the backend
 * process. `/api/system/connections` (admin) reports integration health and the
 * selected runtime's capabilities, without ever exposing credentials.
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'zpanel-backend' }));

  app.get('/api/system/connections', { preHandler: requireRole('admin') }, async () => {
    const [runtimeOk, rconOk] = await Promise.all([runtime.healthy(), rcon.ping()]);
    const filesystemOk = fs.existsSync(paths.serverIni) && fs.existsSync(paths.sandboxVars);
    return {
      backend: 'ok',
      runtime: runtimeOk ? 'ok' : 'error',
      rcon: rconOk ? 'ok' : 'error',
      filesystem: filesystemOk ? 'ok' : 'error',
      database: dbAvailable() ? 'ok' : 'unavailable',
      capabilities: runtime.capabilities(),
    };
  });
}
