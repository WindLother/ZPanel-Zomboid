import path from 'node:path';
import { env } from './env';

/**
 * Centralized, server-controlled filesystem paths. No API parameter ever
 * becomes a path — every location the backend touches is derived here from
 * configuration. See docs/SECURITY.md (path-traversal protection).
 */
const name = env.PZ_SERVER_NAME;
const serverDir = env.PZ_SERVER_DIR;
const zomboidDir = env.PZ_ZOMBOID_DIR;
// The Project Zomboid install root is the parent of the Zomboid data dir
// (e.g. .../380870). SteamCMD downloads Workshop content beneath it.
const installBase = path.dirname(zomboidDir);
// The server INSTALL dir (holds ProjectZomboid64.json + steamapps/). Explicit
// via PZ_INSTALL_DIR, else derived: the Workshop content dir always sits at
// <install>/steamapps/workshop/content/108600, else fall back to installBase.
const installDir =
  env.PZ_INSTALL_DIR ||
  (env.PZ_WORKSHOP_DIR ? path.resolve(env.PZ_WORKSHOP_DIR, '..', '..', '..', '..') : installBase);

export const paths = {
  serverName: name,
  serverDir,
  zomboidDir,

  /** servertest.ini */
  serverIni: path.join(serverDir, `${name}.ini`),
  /** servertest_SandboxVars.lua */
  sandboxVars: path.join(serverDir, `${name}_SandboxVars.lua`),

  /** Read-only Project Zomboid account/whitelist database. */
  serverDb: path.join(zomboidDir, 'db', `${name}.db`),

  /** Directory holding rotating *_DebugLog-server.txt files. */
  logsDir: path.join(zomboidDir, 'Logs'),

  /** Panel-owned backup directory for config files it edits. */
  backupsDir: path.join(zomboidDir, 'Server', '.zpanel-backups'),

  /**
   * Read-only locations where Workshop / local mod content (and their mod.info
   * files) may live for this server. Discovery scans these to resolve a Workshop
   * ID's real Mod IDs. Runtime-agnostic (pure filesystem) — no AMP dependency.
   */
  workshopContentDir: env.PZ_WORKSHOP_DIR || path.join(installBase, 'steamapps', 'workshop', 'content', '108600'),
  zomboidWorkshopDir: path.join(zomboidDir, 'Workshop'),
  localModsDir: path.join(zomboidDir, 'mods'),

  /** PZ server install dir and its authoritative JVM launcher config (read-only). */
  pzInstallDir: installDir,
  pzJvmConfig: path.join(installDir, 'ProjectZomboid64.json'),
} as const;

export type Paths = typeof paths;
