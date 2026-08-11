import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { resolveMutation } from '../../integrations/rcon/mutations';
import { listWhitelistUsernames, listAllowedSteamIds } from '../../integrations/zomboid-db/players';
import { usernameSchema, steamIdSchema } from '../../shared/validation';
import { confirmWithRetry } from '../../shared/retry';
import * as audit from '../activity/service';

/**
 * Whitelist. Listing is read from Project Zomboid's own account database (the
 * only reliable source — RCON does not expose the list). Mutations use official
 * RCON commands, then are CONFIRMED against that database (RCON replies here are
 * not trustworthy — e.g. removeuserfromwhitelist reports success even for a
 * non-existent user). The response returns the authoritative post-state plus an
 * honest { accepted, confirmed }.
 */
const has = (list: string[], v: string) => list.some((x) => x.toLowerCase() === v.toLowerCase());

export async function whitelistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/whitelist', { preHandler: requireAuth }, async () => ({
    users: listWhitelistUsernames(),
    steamIds: listAllowedSteamIds(),
  }));

  app.post('/api/whitelist/users', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.body);
    const raw = await rcon.exec(rconCommands.adduser(username));
    const result = await resolveMutation(raw, () =>
      confirmWithRetry(() => listWhitelistUsernames(), (l) => has(l, username), { attempts: 5, delayMs: 300 }),
    );
    audit.record({ ...actor(req), action: 'whitelist.addUser', target: username, details: { confirmed: result.confirmed }, success: result.accepted });
    return { users: listWhitelistUsernames(), steamIds: listAllowedSteamIds(), ...result };
  });

  app.delete('/api/whitelist/users/:username', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const raw = await rcon.exec(rconCommands.removeUserFromWhitelist(username));
    const result = await resolveMutation(raw, () =>
      confirmWithRetry(() => listWhitelistUsernames(), (l) => !has(l, username), { attempts: 5, delayMs: 300 }),
    );
    audit.record({ ...actor(req), action: 'whitelist.removeUser', target: username, details: { confirmed: result.confirmed }, success: result.accepted });
    return { users: listWhitelistUsernames(), steamIds: listAllowedSteamIds(), ...result };
  });

  app.post('/api/whitelist/steamids', { preHandler: requireRole('admin') }, async (req) => {
    const { steamId } = z.object({ steamId: steamIdSchema }).parse(req.body);
    const raw = await rcon.exec(rconCommands.addSteamId(steamId));
    const result = await resolveMutation(raw, () =>
      confirmWithRetry(() => listAllowedSteamIds(), (l) => l.includes(steamId), { attempts: 5, delayMs: 300 }),
    );
    audit.record({ ...actor(req), action: 'whitelist.addSteamId', target: steamId, details: { confirmed: result.confirmed }, success: result.accepted });
    return { users: listWhitelistUsernames(), steamIds: listAllowedSteamIds(), ...result };
  });

  app.delete('/api/whitelist/steamids/:steamId', { preHandler: requireRole('admin') }, async (req) => {
    const { steamId } = z.object({ steamId: steamIdSchema }).parse(req.params);
    const raw = await rcon.exec(rconCommands.removeSteamId(steamId));
    const result = await resolveMutation(raw, () =>
      confirmWithRetry(() => listAllowedSteamIds(), (l) => !l.includes(steamId), { attempts: 5, delayMs: 300 }),
    );
    audit.record({ ...actor(req), action: 'whitelist.removeSteamId', target: steamId, details: { confirmed: result.confirmed }, success: result.accepted });
    return { users: listWhitelistUsernames(), steamIds: listAllowedSteamIds(), ...result };
  });
}
