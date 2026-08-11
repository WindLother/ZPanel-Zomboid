import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import {
  usernameSchema,
  reasonSchema,
  itemIdSchema,
  itemCountSchema,
  perkSchema,
  xpAmountSchema,
  vehicleScriptSchema,
} from '../../shared/validation';
import { err } from '../../shared/errors';
import { resolveMutation } from '../../integrations/rcon/mutations';
import * as audit from '../activity/service';
import { listPlayers, getPlayer } from './service';
import { confirmKicked, confirmBanned, confirmAccessLevel } from './confirm';
import { frontendLevelToRconArg } from './access';

const POWERS = { godmode: 'godmodplayer', invisible: 'invisibleplayer', noclip: 'noclip' } as const;
type PowerKey = keyof typeof POWERS;

export async function playersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/players', { preHandler: requireAuth }, async () => listPlayers());

  app.get('/api/players/:username', { preHandler: requireAuth }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const p = await getPlayer(username);
    if (!p) throw err.notFound('Player not found.');
    return p;
  });

  app.post('/api/players/:username/kick', { preHandler: requireRole('moderator') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { reason } = z.object({ reason: reasonSchema }).parse(req.body ?? {});
    const raw = await rcon.exec(rconCommands.kick(username, reason));
    const result = await resolveMutation(raw, () => confirmKicked(username));
    audit.record({ ...actor(req), action: 'player.kick', target: username, details: { reason: reason ?? null, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/ban', { preHandler: requireRole('moderator') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { reason, banIp } = z
      .object({ reason: reasonSchema, banIp: z.boolean().default(false) })
      .parse(req.body ?? {});
    const raw = await rcon.exec(rconCommands.ban(username, { ip: banIp, reason }));
    const result = await resolveMutation(raw, () => confirmBanned(username));
    audit.record({ ...actor(req), action: 'player.ban', target: username, details: { banIp, reason: reason ?? null, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/access', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { level } = z.object({ level: z.string() }).parse(req.body);
    const rconArg = frontendLevelToRconArg(level);
    const raw = await rcon.exec(rconCommands.setAccessLevel(username, rconArg));
    const result = await resolveMutation(raw, () => confirmAccessLevel(username, level));
    audit.record({ ...actor(req), action: 'player.access', target: username, details: { level, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/powers/:power', { preHandler: requireRole('admin') }, async (req) => {
    const { username, power } = z
      .object({ username: usernameSchema, power: z.enum(['godmode', 'invisible', 'noclip']) })
      .parse(req.params);
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    // Powers have no queryable authoritative state -> accepted, not confirmable.
    const raw = await rcon.exec(rconCommands.power(POWERS[power as PowerKey], username, on));
    const result = await resolveMutation(raw);
    audit.record({ ...actor(req), action: 'player.power', target: username, details: { power, on, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/items', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { item, count } = z.object({ item: itemIdSchema, count: itemCountSchema }).parse(req.body);
    const raw = await rcon.exec(rconCommands.additem(username, item, count));
    const result = await resolveMutation(raw); // inventory not queryable via RCON
    audit.record({ ...actor(req), action: 'player.giveItem', target: username, details: { item, count, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/xp', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { skill, amount } = z.object({ skill: perkSchema, amount: xpAmountSchema }).parse(req.body);
    const raw = await rcon.exec(rconCommands.addxp(username, skill, amount));
    const result = await resolveMutation(raw); // perk levels not queryable via RCON
    audit.record({ ...actor(req), action: 'player.giveXp', target: username, details: { skill, amount, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });

  app.post('/api/players/:username/vehicles', { preHandler: requireRole('admin') }, async (req) => {
    const { username } = z.object({ username: usernameSchema }).parse(req.params);
    const { vehicle } = z.object({ vehicle: vehicleScriptSchema }).parse(req.body);
    const raw = await rcon.exec(rconCommands.addvehicle(vehicle, username));
    const result = await resolveMutation(raw); // spawned vehicle not queryable via RCON
    audit.record({ ...actor(req), action: 'player.spawnVehicle', target: username, details: { vehicle, confirmed: result.confirmed }, success: result.accepted });
    return result;
  });
}
