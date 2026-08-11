import { z } from 'zod';
import { rconCommands } from '../../integrations/rcon/commands';
import type { Role } from '../auth/service';

/**
 * Strict admin-tool registry. The browser sends only an action id from this
 * map; the backend chooses the exact RCON command. There is NO generic
 * "run whatever the browser sent" passthrough.
 */
export interface AdminAction {
  id: string;
  label: string;
  minRole: Role;
  build: (params: Record<string, unknown>) => string;
}

export const ADMIN_ACTIONS: Record<string, AdminAction> = {
  helicopter: { id: 'helicopter', label: 'Trigger Helicopter', minRole: 'moderator', build: () => rconCommands.chopper() },
  gunshot: { id: 'gunshot', label: 'Trigger Gunshot', minRole: 'moderator', build: () => rconCommands.gunshot() },
  lightning: { id: 'lightning', label: 'Trigger Lightning', minRole: 'moderator', build: () => rconCommands.lightning() },
  alarm: { id: 'alarm', label: 'Sound Alarm', minRole: 'moderator', build: () => rconCommands.alarm() },
  createHorde: {
    id: 'createHorde',
    label: 'Create Horde',
    minRole: 'admin',
    build: (p) => {
      const count = z.coerce.number().int().min(1).max(1000).parse(p.count ?? 50);
      return rconCommands.createHorde(count);
    },
  },
  removeZombies: { id: 'removeZombies', label: 'Remove Zombies', minRole: 'admin', build: () => rconCommands.removeZombies() },
  reloadOptions: { id: 'reloadOptions', label: 'Reload Server Options', minRole: 'admin', build: () => rconCommands.reloadOptions() },
};

// Aliases accepted from the frontend's admin buttons / mock action strings.
export const ADMIN_ALIASES: Record<string, string> = {
  'Trigger Helicopter': 'helicopter',
  chopper: 'helicopter',
  'Trigger Gunshot': 'gunshot',
  'Trigger Lightning': 'lightning',
  'Sound Alarm': 'alarm',
  'Create Horde': 'createHorde',
  'Remove Zombies': 'removeZombies',
  'Reload Server Options': 'reloadOptions',
  reloadoptions: 'reloadOptions',
};

export function resolveAdminAction(idOrLabel: string): AdminAction | null {
  const key = ADMIN_ACTIONS[idOrLabel] ? idOrLabel : ADMIN_ALIASES[idOrLabel];
  return (key && ADMIN_ACTIONS[key]) || null;
}
