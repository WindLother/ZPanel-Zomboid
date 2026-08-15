/**
 * Display grouping, labels and per-key policy for `<servername>.ini` settings.
 *
 * Option METADATA (descriptions, bounds, enum legends) is GENERATED from
 * Project Zomboid's own ini comments — see scripts/generate-settings-schema.ts.
 * PZ does not record UI grouping or operational semantics in that file, so both
 * live here, maintained by hand.
 *
 * Any key matching no rule falls through to "Advanced" — the schema never
 * silently drops a field, and `settings-coverage.test.ts` enforces that.
 */
import type { SettingKind, SettingPolicy } from './types';

/** Group id -> display title, in the order the UI shows them. */
export const GROUPS: Array<{ id: string; title: string }> = [
  { id: 'general', title: 'General' },
  { id: 'network', title: 'Network & Ports' },
  { id: 'access', title: 'Access & Accounts' },
  { id: 'display', title: 'Display & Names' },
  { id: 'chat', title: 'Chat & Announcements' },
  { id: 'voip', title: 'Voice (VOIP)' },
  { id: 'pvp', title: 'PvP & Safety' },
  { id: 'safehouse', title: 'Safehouse' },
  { id: 'faction', title: 'Factions & War' },
  { id: 'world', title: 'World & Gameplay' },
  { id: 'vehicles', title: 'Vehicles' },
  { id: 'moderation', title: 'Moderation & Logging' },
  { id: 'anticheat', title: 'Anti-Cheat' },
  { id: 'integrations', title: 'Discord & Webhooks' },
  { id: 'backups', title: 'Backups & Saving' },
  { id: 'identity', title: 'Server Identity' },
  { id: 'advanced', title: 'Advanced' },
];

export const GROUP_ORDER = GROUPS.map((g) => g.id);

/**
 * Keys the Server Settings editor must NEVER own.
 *
 * `Mods` / `WorkshopItems` are the Mods page's domain (one Workshop item can
 * provide many Mod IDs — see AGENTS.md §9). Exposing them here would let a
 * settings save overwrite the mod list with whatever the browser last loaded.
 */
export const EXCLUDED_KEYS = new Set(['Mods', 'WorkshopItems']);

/** Explicit group placement: group id -> the ini keys it contains. */
const PLACEMENT: Array<{ group: string; keys: string[] }> = [
  {
    group: 'general',
    keys: ['PublicName', 'PublicDescription', 'Map', 'Seed', 'MaxPlayers', 'Password', 'Open', 'Public', 'PauseEmpty'],
  },
  {
    group: 'network',
    keys: [
      'DefaultPort', 'UDPPort', 'RCONPort', 'RCONPassword', 'UPnP', 'PingLimit', 'MaxPacketsPerSecond',
      'server_browser_announced_ip', 'DenyLoginOnOverloadedServer', 'LoginQueueEnabled', 'LoginQueueConnectTimeout',
    ],
  },
  {
    group: 'access',
    keys: [
      'AutoCreateUserInWhiteList', 'DropOffWhiteListAfterDeath', 'MaxAccountsPerUser', 'AllowNonAsciiUsername',
      'AllowCoop', 'SteamVAC', 'DoLuaChecksum',
    ],
  },
  {
    group: 'display',
    keys: [
      'DisplayUserName', 'ShowFirstAndLastName', 'UsernameDisguises', 'HideDisguisedUserName',
      'MouseOverToSeeDisplayName', 'HideAdminsInPlayerList', 'HidePlayersBehindYou', 'ShowCoordinates',
      'SteamScoreboard', 'DisableScoreboard', 'MapRemotePlayerVisibility',
    ],
  },
  {
    group: 'chat',
    keys: [
      'GlobalChat', 'ChatStreams', 'ChatMessageCharacterLimit', 'ChatMessageSlowModeTime', 'ServerWelcomeMessage',
      'BadWordPolicy', 'BadWordListFile', 'GoodWordListFile', 'BadWordReplacement', 'AnnounceDeath',
      'AnnounceAnimalDeath', 'BanKickGlobalSound',
    ],
  },
  { group: 'voip', keys: ['VoiceEnable', 'Voice3D', 'VoiceMinDistance', 'VoiceMaxDistance'] },
  {
    group: 'pvp',
    keys: [
      'PVP', 'PVPLogToolChat', 'PVPLogToolFile', 'PVPMeleeDamageModifier', 'PVPFirearmDamageModifier',
      'PVPMeleeWhileHitReaction', 'SafetySystem', 'ShowSafety', 'SafetyToggleTimer', 'SafetyCooldownTimer',
      'SafetyDisconnectDelay', 'PlayerBumpPlayer', 'KnockedDownAllowed', 'UsePhysicsHitReaction',
      'SneakModeHideFromOtherPlayers',
    ],
  },
  {
    group: 'safehouse',
    keys: [
      'PlayerSafehouse', 'AdminSafehouse', 'SafehouseAllowTrepass', 'SafehouseAllowFire', 'SafehouseAllowLoot',
      'SafehouseAllowRespawn', 'SafehouseAllowNonResidential', 'SafehouseDaySurvivedToClaim', 'SafeHouseRemovalTime',
      'SafehouseDisableDisguises', 'SafehousePreventsLootRespawn', 'DisableSafehouseWhenOwnerConnected',
      'MaxSafezoneSize', 'SledgehammerOnlyInSafehouse', 'AllowDestructionBySledgehammer',
    ],
  },
  {
    group: 'faction',
    keys: [
      'Faction', 'FactionDaySurvivedToCreate', 'FactionPlayersRequiredForTag', 'War', 'WarStartDelay', 'WarDuration',
      'WarSafehouseHitPoints',
    ],
  },
  {
    group: 'world',
    keys: [
      'SpawnPoint', 'SpawnItems', 'PlayerRespawnWithSelf', 'PlayerRespawnWithOther', 'SleepAllowed', 'SleepNeeded',
      'NoFire', 'FastForwardMultiplier', 'UltraSpeedDoesnotAffectToAnimals', 'BloodSplatLifespanDays',
      'RemovePlayerCorpsesOnCorpseRemoval', 'TrashDeleteAll', 'ItemNumbersLimitPerContainer',
      'SwitchZombiesOwnershipEachUpdate',
    ],
  },
  {
    group: 'vehicles',
    keys: ['SpeedLimit', 'CarEngineAttractionModifier', 'DisableVehicleTowing', 'DisableTrailerTowing', 'DisableBurntTowing'],
  },
  {
    group: 'moderation',
    keys: [
      'PerkLogs', 'ClientActionLogs', 'ClientCommandFilter', 'MultiplayerStatisticsPeriod', 'DisableRadioStaff',
      'DisableRadioAdmin', 'DisableRadioGM', 'DisableRadioOverseer', 'DisableRadioModerator', 'DisableRadioInvisible',
    ],
  },
  {
    group: 'anticheat',
    keys: [
      'AntiCheatChecksum', 'AntiCheatHit', 'AntiCheatNoClip', 'AntiCheatPacketException', 'AntiCheatPermission',
      'AntiCheatPlayer', 'AntiCheatSafeHouse', 'AntiCheatSafety', 'AntiCheatSpeed', 'AntiCheatXP',
    ],
  },
  {
    group: 'integrations',
    keys: ['DiscordEnable', 'DiscordToken', 'DiscordChatChannel', 'DiscordCommandChannel', 'DiscordLogChannel', 'WebhookAddress'],
  },
  { group: 'backups', keys: ['BackupsCount', 'BackupsOnStart', 'BackupsOnVersionChange', 'BackupsPeriod', 'SaveWorldEveryMinutes'] },
  { group: 'identity', keys: ['ResetID', 'ServerPlayerID'] },
];

const GROUP_BY_KEY = new Map<string, string>();
for (const { group, keys } of PLACEMENT) for (const k of keys) GROUP_BY_KEY.set(k, group);

/** Group for an ini key; unrecognised keys fall through to "Advanced". */
export function groupFor(iniKey: string): string {
  return GROUP_BY_KEY.get(iniKey) ?? 'advanced';
}

/** Labels PZ's key name does not produce nicely on its own. */
const LABELS: Record<string, string> = {
  PublicName: 'Server Name',
  PublicDescription: 'Description',
  PVP: 'PvP',
  PVPLogToolChat: 'Log PvP To Admin Chat',
  PVPLogToolFile: 'Log PvP To File',
  PVPMeleeDamageModifier: 'PvP Melee Damage Multiplier',
  PVPFirearmDamageModifier: 'PvP Firearm Damage Multiplier',
  PVPMeleeWhileHitReaction: 'PvP Melee During Hit Reaction',
  UPnP: 'UPnP Port Forwarding',
  RCONPort: 'RCON Port',
  RCONPassword: 'RCON Password',
  UDPPort: 'UDP Port',
  MaxAccountsPerUser: 'Max Accounts Per Steam User',
  AutoCreateUserInWhiteList: 'Auto-create Whitelist Users',
  DropOffWhiteListAfterDeath: 'Remove From Whitelist On Death',
  DoLuaChecksum: 'Enforce Lua Checksum',
  SteamVAC: 'Steam VAC',
  Voice3D: '3D Voice',
  VoiceMinDistance: 'Voice Minimum Distance',
  VoiceMaxDistance: 'Voice Maximum Distance',
  server_browser_announced_ip: 'Announced IP (Server Browser)',
  ResetID: 'Reset ID',
  ServerPlayerID: 'Server Player ID',
  SafeHouseRemovalTime: 'Safehouse Removal Time',
  MapRemotePlayerVisibility: 'Remote Player Map Visibility',
  ItemNumbersLimitPerContainer: 'Item Limit Per Container',
  UltraSpeedDoesnotAffectToAnimals: 'Ultra Speed Excludes Animals',
};

/** Human label for an ini key: explicit override, else de-camel-cased. */
export function labelFor(iniKey: string): string {
  if (LABELS[iniKey]) return LABELS[iniKey];
  return iniKey
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Keys Project Zomboid supports but which the generator's sample ini does not
 * contain (PZ only writes them in some configurations). Declared by hand so the
 * panel can still manage them where a server does have them. A field absent
 * from the live file is never displayed and never introduced — same rule as
 * sandbox (AGENTS.md §8b).
 */
export const EXTRA_FIELDS: Array<{
  iniKey: string;
  kind: SettingKind;
  desc?: string;
  min?: number;
  max?: number;
}> = [
  {
    iniKey: 'AutoCreateUserInWhiteList',
    kind: 'toggle',
    desc:
      'Allow new accounts to be created automatically on first login when the server is not open to everyone. ' +
      'Ignored when Open is true.',
  },
];

/**
 * Per-key operational policy.
 *
 * `live` is claimed ONLY where a runtime `changeoption` + `reloadoptions` is
 * known to take effect — the panel must never report that a change applied when
 * it did not (AGENTS.md §1 rule 18). Everything else defaults to
 * `restart: true`, which is the safe direction to be wrong in: at worst the
 * change took effect sooner than the UI promised. Promote a key to `live` only
 * after verifying it against a real server.
 */
export const POLICY: Record<string, SettingPolicy> = {
  // --- verified runtime-applicable -----------------------------------------
  PublicName: { live: true },
  PublicDescription: { live: true, kind: 'textarea' },
  PVP: { live: true },
  PauseEmpty: { live: true },
  SafetySystem: { live: true },
  GlobalChat: { live: true },

  // --- secrets: value never leaves the backend -----------------------------
  Password: { secret: true, restart: true, kind: 'text' },
  RCONPassword: {
    secret: true,
    restart: true,
    warning: "Changing this breaks the panel's own RCON connection until PZ_RCON_PASSWORD is updated to match.",
  },
  DiscordToken: { secret: true, restart: true, kind: 'text' },

  // --- long-form text -------------------------------------------------------
  ServerWelcomeMessage: { kind: 'textarea', restart: true, maxLength: 4000 },

  // --- keys whose sample value is empty, so the kind must be declared -------
  BadWordListFile: { kind: 'text', restart: true },
  GoodWordListFile: { kind: 'text', restart: true },
  DiscordChatChannel: { kind: 'text', restart: true },
  DiscordCommandChannel: { kind: 'text', restart: true },
  DiscordLogChannel: { kind: 'text', restart: true },
  WebhookAddress: { kind: 'text', restart: true },
  SpawnItems: { kind: 'text', restart: true },
  server_browser_announced_ip: { kind: 'text', restart: true },

  // --- dangerous / operator-caution ----------------------------------------
  DefaultPort: { restart: true, warning: 'Players connect on this port. Changing it changes your server address.' },
  UDPPort: { restart: true, warning: 'Players connect on this port. Changing it changes your server address.' },
  RCONPort: {
    restart: true,
    warning: "Changing this breaks the panel's own RCON connection until PZ_RCON_PORT is updated to match.",
  },
  ResetID: {
    restart: true,
    warning: 'Changing this forces EVERY player to create a new character (soft reset). Back up the world first.',
  },
  ServerPlayerID: {
    restart: true,
    warning: 'Used together with Reset ID to identify characters. Changing it can invalidate existing characters.',
  },
  Map: { restart: true, warning: 'Changing the map on an existing world will not migrate your save.' },
  Seed: { restart: true, warning: 'Only affects newly generated world chunks; it does not regenerate an existing map.' },
};
