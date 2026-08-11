import fsp from 'node:fs/promises';
import { paths } from '../../config/paths';
import { err } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { atomicWrite, backupFile, restoreBackup } from './backups';
import { parseIni, patchIni, type ParsedIni } from './ini';
import { parseSandbox, patchSandbox, type LuaScalar, type ParsedSandbox } from './sandbox';

/** Read + parse servertest.ini. */
export async function readServerIni(): Promise<ParsedIni & { text: string }> {
  const text = await fsp.readFile(paths.serverIni, 'utf8');
  return { ...parseIni(text), text };
}

/**
 * Apply an allowlisted patch to servertest.ini with backup + atomic write and
 * rollback on failure. Unknown keys in the file are preserved.
 */
export async function writeServerIni(patch: Record<string, string>): Promise<void> {
  const text = await fsp.readFile(paths.serverIni, 'utf8');
  const next = patchIni(text, patch);
  const backup = await backupFile(paths.serverIni);
  try {
    await atomicWrite(paths.serverIni, next);
    logger.info({ keys: Object.keys(patch) }, 'servertest.ini updated');
  } catch (e) {
    await restoreBackup(paths.serverIni, backup).catch(() => undefined);
    throw err.configWrite(`Failed to write servertest.ini: ${(e as Error).message}`);
  }
}

/** Read + parse the SandboxVars.lua file. */
export async function readSandbox(): Promise<ParsedSandbox> {
  const text = await fsp.readFile(paths.sandboxVars, 'utf8');
  return parseSandbox(text);
}

/**
 * Apply an allowlisted patch to SandboxVars.lua (safe: not AMP-owned). Backup +
 * atomic write + rollback + re-parse verification so a corrupt result is never
 * left on disk.
 */
export async function writeSandbox(patch: Record<string, LuaScalar>): Promise<void> {
  const parsed = await readSandbox();
  const next = patchSandbox(parsed, patch);
  // Verify the result re-parses before committing.
  parseSandbox(next);
  const backup = await backupFile(paths.sandboxVars);
  try {
    await atomicWrite(paths.sandboxVars, next);
    logger.info({ keys: Object.keys(patch) }, 'SandboxVars.lua updated');
  } catch (e) {
    await restoreBackup(paths.sandboxVars, backup).catch(() => undefined);
    throw err.configWrite(`Failed to write SandboxVars.lua: ${(e as Error).message}`);
  }
}
