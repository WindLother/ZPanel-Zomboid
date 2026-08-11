import { z } from 'zod';

/**
 * Allowlisted server settings. The browser can only write keys defined here, and
 * only values that pass `validate`. Everything else in servertest.ini is
 * preserved untouched (patch semantics). `iniKey` bridges the frontend's chosen
 * key to the real Project Zomboid ini key discovered on this server (e.g. the
 * frontend "ServerName" is the ini "PublicName").
 *
 * IMPORTANT: every ini key here is AMP-owned (AMP regenerates the ini from its
 * GenericModule AppSettings on restart). See docs/AMP.md. Writes go through the
 * file with backup+atomic, and `restart` / `live` describe how a change takes
 * effect.
 */

export type FieldType = 'text' | 'textarea' | 'number' | 'toggle';

export interface SettingDef {
  key: string; // frontend/canonical key
  iniKey: string; // real key in servertest.ini
  label: string;
  desc?: string;
  type: FieldType;
  group: { id: string; title: string };
  /** parse ini string -> frontend value */
  fromIni: (raw: string | undefined) => unknown;
  /** validate a frontend value and return the ini string to persist */
  toIni: (value: unknown) => string;
  restart?: boolean; // requires a server restart to take effect
  live?: boolean; // safely applicable at runtime via changeoption+reloadoptions
  secret?: boolean;
  min?: number;
  max?: number;
}

const G = {
  general: { id: 'general', title: 'General' },
  visibility: { id: 'visibility', title: 'Visibility' },
  gameplay: { id: 'gameplay', title: 'Gameplay' },
  network: { id: 'network', title: 'Network' },
  access: { id: 'access', title: 'Access' },
};

const boolField = (
  key: string,
  iniKey: string,
  label: string,
  group: { id: string; title: string },
  opts: Partial<SettingDef> = {},
): SettingDef => ({
  key,
  iniKey,
  label,
  type: 'toggle',
  group,
  fromIni: (raw) => String(raw).toLowerCase() === 'true',
  toIni: (v) => (z.boolean().parse(v) ? 'true' : 'false'),
  ...opts,
});

const numberField = (
  key: string,
  iniKey: string,
  label: string,
  group: { id: string; title: string },
  min: number,
  max: number,
  opts: Partial<SettingDef> = {},
): SettingDef => ({
  key,
  iniKey,
  label,
  type: 'number',
  group,
  min,
  max,
  fromIni: (raw) => (raw === undefined || raw === '' ? 0 : Number(raw)),
  toIni: (v) => String(z.coerce.number().int().min(min).max(max).parse(v)),
  ...opts,
});

const textField = (
  key: string,
  iniKey: string,
  label: string,
  group: { id: string; title: string },
  opts: Partial<SettingDef> = {},
): SettingDef => ({
  key,
  iniKey,
  label,
  type: 'text',
  group,
  fromIni: (raw) => raw ?? '',
  toIni: (v) => z.string().max(500).parse(v),
  ...opts,
});

export const SETTINGS: SettingDef[] = [
  // General
  textField('ServerName', 'PublicName', 'Server Name', G.general, {
    desc: 'Shown in the public server browser.',
    live: true,
  }),
  {
    ...textField('Description', 'PublicDescription', 'Description', G.general, {
      desc: 'Short public description.',
    }),
    type: 'textarea',
  },
  textField('Password', 'Password', 'Password', G.general, {
    desc: 'Leave empty for no password.',
    secret: true,
    restart: true,
  }),
  numberField('MaxPlayers', 'MaxPlayers', 'Maximum Players', G.general, 1, 100, {
    desc: 'Concurrent player slots.',
    restart: true,
  }),

  // Visibility
  boolField('Public', 'Public', 'Public Server', G.visibility, {
    desc: 'List the server in the in-game browser.',
  }),
  boolField('Open', 'Open', 'Open Server', G.visibility, {
    desc: 'When off, only whitelisted accounts may join.',
  }),

  // Gameplay
  boolField('PVP', 'PVP', 'PvP', G.gameplay, {
    desc: 'Allow players to damage each other.',
    live: true,
  }),
  boolField('PauseEmpty', 'PauseEmpty', 'Pause When Empty', G.gameplay, {
    desc: 'Freeze world time with no players online.',
    live: true,
  }),
  boolField('SafetySystem', 'SafetySystem', 'Safety System', G.gameplay, {
    desc: 'Players must enable PvP mode before fighting.',
    live: true,
  }),
  boolField('GlobalChat', 'GlobalChat', 'Global Chat', G.gameplay, {
    desc: 'Server-wide text chat.',
    live: true,
  }),

  // Network (ports require restart)
  numberField('DefaultPort', 'DefaultPort', 'Default Port', G.network, 0, 65535, {
    desc: 'Game traffic.',
    restart: true,
  }),
  numberField('UDPPort', 'UDPPort', 'UDP Port', G.network, 0, 65535, {
    desc: 'Direct connection port.',
    restart: true,
  }),
  numberField('RCONPort', 'RCONPort', 'RCON Port', G.network, 0, 65535, {
    desc: 'Remote administration port.',
    restart: true,
  }),
  textField('RCONPassword', 'RCONPassword', 'RCON Password', G.network, {
    desc: "Used by this panel's backend only.",
    secret: true,
    restart: true,
  }),

  // Access
  boolField('AutoCreateUser', 'AutoCreateUserInWhiteList', 'Auto-create Whitelist Users', G.access, {
    desc: 'First login registers the account automatically.',
  }),
  boolField('DropOffWhiteListAfterDeath', 'DropOffWhiteListAfterDeath', 'Remove From Whitelist On Death', G.access, {
    desc: 'Permadeath enforcement.',
  }),
  numberField('MaxAccountsPerUser', 'MaxAccountsPerUser', 'Max Accounts Per User', G.access, 0, 10, {
    desc: '0 = unlimited.',
  }),
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
