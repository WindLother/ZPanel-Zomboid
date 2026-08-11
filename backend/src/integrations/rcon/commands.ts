import { assertRconArg } from '../../shared/validation';

/**
 * Typed builders for the exact command forms confirmed against this Build 42
 * server's live `help` output. The browser never supplies a command name — it
 * chooses a dedicated endpoint, and these builders assemble the only allowed
 * string. Every interpolated argument is validated/escaped first.
 *
 * Confirmed syntax (from the running server):
 *   players
 *   save
 *   servermsg "text"
 *   kickuser "user" -r "reason"
 *   banuser "user" -ip -r "reason"
 *   setaccesslevel "user" "Level"     (Admin|Moderator|Overseer|GM|Observer)
 *   godmodplayer "user" -true|-false
 *   invisibleplayer "user" -true|-false
 *   noclip "user" -true|-false
 *   additem "user" "Module.Item" count
 *   addxp "user" Perk=amount
 *   addvehicle "Module.Vehicle" "user"
 *   adduser "user"
 *   removeuserfromwhitelist "user"
 *   addsteamid "steamid" / removesteamid "steamid"
 *   changeoption optionName "value"   + reloadoptions
 *   admin world tools: alarm, chopper, gunshot, lightning, createhorde N "user", removezombies
 */

const q = (v: string, field: string) => `"${assertRconArg(v, field)}"`;

export const rconCommands = {
  players: () => 'players',
  save: () => 'save',
  showOptions: () => 'showoptions',
  reloadOptions: () => 'reloadoptions',
  checkModsNeedUpdate: () => 'checkModsNeedUpdate',

  servermsg: (message: string) => `servermsg ${q(message, 'message')}`,

  kick: (user: string, reason?: string) =>
    `kickuser ${q(user, 'username')}${reason ? ` -r ${q(reason, 'reason')}` : ''}`,

  ban: (user: string, opts: { ip?: boolean; reason?: string } = {}) =>
    `banuser ${q(user, 'username')}${opts.ip ? ' -ip' : ''}${
      opts.reason ? ` -r ${q(opts.reason, 'reason')}` : ''
    }`,

  unban: (user: string) => `unbanuser ${q(user, 'username')}`,

  setAccessLevel: (user: string, level: string) =>
    `setaccesslevel ${q(user, 'username')} ${q(level, 'level')}`,

  power: (command: 'godmodplayer' | 'invisibleplayer' | 'noclip', user: string, on: boolean) =>
    `${command} ${q(user, 'username')} ${on ? '-true' : '-false'}`,

  additem: (user: string, item: string, count: number) =>
    `additem ${q(user, 'username')} ${q(item, 'item')} ${Math.trunc(count)}`,

  addxp: (user: string, perk: string, amount: number) =>
    // addxp uses an unquoted Perk=amount token; perk is validated alphabetic.
    `addxp ${q(user, 'username')} ${assertRconArg(perk, 'perk')}=${Math.trunc(amount)}`,

  addvehicle: (script: string, user: string) =>
    `addvehicle ${q(script, 'vehicle')} ${q(user, 'username')}`,

  adduser: (user: string) => `adduser ${q(user, 'username')}`,
  removeUserFromWhitelist: (user: string) => `removeuserfromwhitelist ${q(user, 'username')}`,

  addSteamId: (steamId: string) => `addsteamid ${q(steamId, 'steamId')}`,
  removeSteamId: (steamId: string) => `removesteamid ${q(steamId, 'steamId')}`,

  changeOption: (name: string, value: string) =>
    `changeoption ${assertRconArg(name, 'option')} ${q(value, 'value')}`,

  // World / admin tools (no free-form arguments).
  alarm: () => 'alarm',
  chopper: () => 'chopper',
  gunshot: () => 'gunshot',
  lightning: () => 'lightning',
  createHorde: (count: number, user?: string) =>
    `createhorde ${Math.trunc(count)}${user ? ` ${q(user, 'username')}` : ''}`,
  removeZombies: () => 'removezombies',
} as const;
