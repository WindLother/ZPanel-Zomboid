import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../../config/paths';
import { err } from '../../shared/errors';
import { logger } from '../../shared/logger';

const RETENTION = 10;

/** Timestamp with no Date.now dependency issues in tooling; safe here at runtime. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy `filePath` into the panel-owned backup directory before it is modified.
 * Keeps at most RETENTION backups per file (oldest pruned). Returns the backup
 * path so a failed write can be restored from it.
 */
export async function backupFile(filePath: string): Promise<string> {
  await fsp.mkdir(paths.backupsDir, { recursive: true });
  const base = path.basename(filePath);
  const dest = path.join(paths.backupsDir, `${base}.${stamp()}.bak`);
  await fsp.copyFile(filePath, dest);
  await prune(base);
  logger.info({ file: base, backup: path.basename(dest) }, 'config backup created');
  return dest;
}

async function prune(base: string): Promise<void> {
  const entries = (await fsp.readdir(paths.backupsDir))
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
    .sort();
  const excess = entries.length - RETENTION;
  for (let i = 0; i < excess; i++) {
    await fsp.rm(path.join(paths.backupsDir, entries[i]), { force: true });
  }
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, then rename
 * over the target (rename is atomic on the same filesystem). Preserves the
 * existing file mode. Assumes a backup was already taken by the caller.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${stamp()}`);
  let mode = 0o644;
  try {
    mode = (await fsp.stat(filePath)).mode & 0o777;
  } catch {
    /* new file — default mode */
  }
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, filePath);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw err.configWrite(`Atomic rename failed: ${(e as Error).message}`);
  }
}

/** Restore a file from a previously created backup (best effort). */
export async function restoreBackup(filePath: string, backupPath: string): Promise<void> {
  if (!fs.existsSync(backupPath)) throw err.configWrite('Backup no longer exists.');
  await fsp.copyFile(backupPath, filePath);
}
