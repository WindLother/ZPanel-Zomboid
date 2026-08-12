import fs from 'node:fs';
import { paths } from '../../config/paths';
import { logger } from '../../shared/logger';

/**
 * Configured maximum Java heap of the Project Zomboid server, read from the
 * authoritative launcher config `ProjectZomboid64.json` (the file the official
 * `start-server.sh` / ProjectZomboid64 launcher feeds to the embedded JVM).
 *
 * This exists because launcher-style processes do NOT carry `-Xmx` on their own
 * command line (the launcher reads it from this JSON), so /proc cmdline parsing
 * alone cannot see the heap ceiling. AMP-style `java ...` processes DO carry
 * `-Xmx` in cmdline, which then reflects the running process directly — callers
 * prefer cmdline first and fall back to this file (see os/proc.ts).
 *
 * Read-only. Never fabricates: returns null when the file or the flag is absent.
 */

const XMX_RE = /^-Xmx(\d+)([kmg])?$/i;

/** Parse a single JVM `-Xmx` argument (e.g. "-Xmx3072m", "-Xmx12g") to bytes. */
export function parseXmxBytes(arg: string): number | null {
  const m = XMX_RE.exec(arg.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = m[2] ? ({ k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const)[m[2].toLowerCase() as 'k' | 'm' | 'g'] : 1;
  return n * mult;
}

/**
 * Read the configured heap from a ProjectZomboid64.json file. The last `-Xmx`
 * entry in `vmArgs` wins (matching JVM semantics for repeated flags).
 */
export function configuredHeapBytes(file: string = paths.pzJvmConfig): number | null {
  try {
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { vmArgs?: unknown };
    if (!Array.isArray(data.vmArgs)) return null;
    let bytes: number | null = null;
    for (const arg of data.vmArgs) {
      if (typeof arg !== 'string') continue;
      const parsed = parseXmxBytes(arg);
      if (parsed != null) bytes = parsed;
    }
    return bytes;
  } catch (e) {
    logger.debug({ file, err: (e as Error).message }, 'ProjectZomboid64.json unreadable; heap limit unknown');
    return null;
  }
}
