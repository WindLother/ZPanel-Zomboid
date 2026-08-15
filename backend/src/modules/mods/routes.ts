import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole, actor } from '../../plugins/auth';
import * as audit from '../activity/service';
import {
  addWorkshopItem,
  applyModUpdates,
  checkModUpdates,
  listWorkshopItems,
  lookupWorkshop,
  moveWorkshopItem,
  removeStandaloneMod,
  removeWorkshopItem,
  toggleWorkshop,
} from './service';

const workshopIdParam = z.object({ workshopId: z.string().regex(/^\d{6,12}$/, 'Workshop ID must be 6–12 digits.') });
const modIdParam = z.object({ modId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Invalid Mod ID.') });

export async function modsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mods', { preHandler: requireAuth }, async () => listWorkshopItems());

  // Resolve a Workshop ID's real Mod ID(s) from downloaded content (no network).
  // Moderator: this is step 1 of the add flow and mutates nothing.
  app.post('/api/mods/lookup', { preHandler: requireRole('moderator') }, async (req) => {
    const { workshopId } = z.object({ workshopId: z.string().trim() }).parse(req.body);
    return lookupWorkshop(workshopId);
  });

  // Add a Workshop item + selected/entered Mod IDs (structured; never raw Mods=).
  // Moderators curate the mod list: add / remove / enable / disable. Load-order
  // moves and content updates stay admin-only.
  app.post('/api/mods', { preHandler: requireRole('moderator') }, async (req) => {
    const body = z
      .object({ workshopId: z.string().trim(), modIds: z.array(z.string().trim()).min(1).max(64) })
      .parse(req.body);
    const result = await addWorkshopItem(body);
    audit.record({
      ...actor(req),
      action: 'mods.add',
      target: result.workshopId,
      details: { modIds: [...result.addedModIds], alreadyPresent: result.alreadyPresentModIds },
      success: true,
    });
    return { ...result, ampManaged: true };
  });

  app.delete('/api/mods/:workshopId', { preHandler: requireRole('moderator') }, async (req) => {
    const { workshopId } = workshopIdParam.parse(req.params);
    const result = await removeWorkshopItem(workshopId);
    audit.record({ ...actor(req), action: 'mods.remove', target: workshopId, details: { removedModIds: result.removedModIds }, success: true });
    return { ...result, ampManaged: true };
  });

  // Remove a standalone/local Mod ID (a `Mods=` entry owned by no Workshop item).
  app.delete('/api/mods/standalone/:modId', { preHandler: requireRole('moderator') }, async (req) => {
    const { modId } = modIdParam.parse(req.params);
    const result = await removeStandaloneMod(modId);
    audit.record({ ...actor(req), action: 'mods.removeStandalone', target: modId, success: true });
    return { ...result, ampManaged: true };
  });

  // Enable/disable keeps the Workshop item and only edits `Mods=` — strictly
  // less destructive than remove, so it cannot be more restricted than it.
  app.post('/api/mods/:workshopId/toggle', { preHandler: requireRole('moderator') }, async (req) => {
    const { workshopId } = workshopIdParam.parse(req.params);
    const result = await toggleWorkshop(workshopId);
    audit.record({ ...actor(req), action: 'mods.toggle', target: workshopId, success: true });
    return { ...result, ampManaged: true };
  });

  app.post('/api/mods/:workshopId/move', { preHandler: requireRole('admin') }, async (req) => {
    const { workshopId } = workshopIdParam.parse(req.params);
    const { direction } = z.object({ direction: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body);
    const result = await moveWorkshopItem(workshopId, direction);
    audit.record({ ...actor(req), action: 'mods.move', target: workshopId, details: { direction }, success: true });
    return { ...result, ampManaged: true };
  });

  app.post('/api/mods/check-updates', { preHandler: requireRole('moderator') }, async (req) => {
    const result = await checkModUpdates();
    audit.record({
      ...actor(req),
      action: 'mods.checkUpdates',
      success: result.accepted,
      details: {
        checked: result.checked,
        outdated: result.outdated,
        verdict: result.verdict,
        // Record WHICH items the server named, so the trail is specific too.
        outdatedIds: result.items.filter((i) => i.needsUpdate === true).map((i) => i.workshopId),
      },
    });
    return result;
  });

  // Applying updates: the runtime does it when it owns updates (AMP), otherwise
  // Project Zomboid fetches Workshop content at startup, so a restart is the
  // real mechanism. Never reports success for something that did not happen.
  app.post('/api/mods/update', { preHandler: requireRole('admin') }, async (req) => {
    const result = await applyModUpdates();
    audit.record({
      ...actor(req),
      action: 'mods.update',
      success: result.ok,
      details: { applyVia: result.applyVia, pending: result.pending },
    });
    return result;
  });
}
