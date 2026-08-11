import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, actor } from '../../plugins/auth';
import { rcon } from '../../integrations/rcon/service';
import { err } from '../../shared/errors';
import * as audit from '../activity/service';
import { validateConsoleLine } from './allowlist';

/**
 * Server console == the Project Zomboid game console over RCON. NEVER a shell.
 * Commands are allowlisted and parsed; there is no arbitrary passthrough. A
 * bounded in-memory ring buffer keeps recent lines for `recent()`.
 */
export interface ConsoleLine {
  kind: 'cmd' | 'out' | 'err';
  time: string;
  text: string;
}

const HISTORY_MAX = 200;
const history: ConsoleLine[] = [];

function push(line: ConsoleLine): void {
  history.push(line);
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}

const now = () => new Date().toTimeString().slice(0, 8);

export async function consoleRoutes(app: FastifyInstance): Promise<void> {
  // The console is an ADMIN capability (§45): its allowlist includes admin-level
  // game commands (setaccesslevel, additem, addxp, adduser, …). Gating it at
  // 'moderator' would let a moderator escalate privileges via the console,
  // bypassing the admin-only dedicated endpoints. Require admin for both read
  // (output can contain steamids/config from showoptions) and execute.
  app.get('/api/console', { preHandler: requireRole('admin') }, async () => history.slice());

  app.post('/api/console/command', { preHandler: requireRole('admin') }, async (req) => {
    const { command } = z.object({ command: z.string().min(1).max(200) }).parse(req.body);

    let parsed: { name: string; command: string };
    try {
      parsed = validateConsoleLine(command);
    } catch (e) {
      throw err.invalid((e as Error).message);
    }

    const cmdLine: ConsoleLine = { kind: 'cmd', time: now(), text: parsed.command };
    push(cmdLine);

    try {
      const raw = await rcon.exec(parsed.command);
      const text = raw.trim() || 'OK';
      const out: ConsoleLine[] = text.split('\n').map((t) => ({ kind: 'out' as const, time: now(), text: t.replace(/\r$/, '') }));
      out.forEach(push);
      audit.record({ ...actor(req), action: 'console.command', target: parsed.name, success: true });
      return [cmdLine, ...out];
    } catch (e) {
      const line: ConsoleLine = { kind: 'err', time: now(), text: (e as Error).message };
      push(line);
      audit.record({ ...actor(req), action: 'console.command', target: parsed.name, success: false });
      return [cmdLine, line];
    }
  });
}
