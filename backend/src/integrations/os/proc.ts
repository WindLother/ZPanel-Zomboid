import fsp from 'node:fs/promises';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { configuredHeapBytes } from '../zomboid-files/jvm-config';
import type { RuntimeState } from '../runtime/types';

/**
 * OS-level observation of the Project Zomboid process via /proc. This is neutral
 * infrastructure — NOT AMP-specific — used by any runtime adapter that wants
 * process metrics without a management API. It only READS /proc (plus the PZ
 * launcher config for the configured heap ceiling); it never kills or spawns
 * the process.
 */

const CLK_TCK = 100; // sysconf(_SC_CLK_TCK) is 100 on Linux by default.

export interface ProcSample {
  state: RuntimeState;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  uptimeSeconds: number | null;
  source: string;
}

let lastCpuSample: { pid: number; jiffies: number; at: number } | null = null;

/** Find the Project Zomboid GameServer pid by matching its command line. */
export async function findPzPid(): Promise<number | null> {
  let dirs: string[];
  try {
    dirs = await fsp.readdir('/proc');
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = await fsp.readFile(`/proc/${d}/cmdline`, 'utf8');
      const flat = cmd.replace(/\0/g, ' ');
      // Match either process style, scoped to the configured server name so the
      // two servers never cross-match:
      //   AMP-style:      java ... zombie.network.GameServer ... -servername <name>
      //   launcher-style: ./ProjectZomboid64 -servername <name>
      const isPz = flat.includes('zombie.network.GameServer') || flat.includes('ProjectZomboid');
      if (isPz && flat.includes(env.PZ_SERVER_NAME)) {
        return parseInt(d, 10);
      }
    } catch {
      /* process vanished; skip */
    }
  }
  return null;
}

/**
 * Configured max Java heap. Resolution order:
 *   1. the process's own `-Xmx` cmdline argument (AMP-style `java ...` launches
 *      carry it — this reflects the actually-running process);
 *   2. the authoritative launcher config ProjectZomboid64.json (launcher-style
 *      processes read `-Xmx` from there, so it never appears in their cmdline).
 * Honest null when neither source has it — never a hardcoded guess.
 */
async function xmxLimitBytes(pid: number): Promise<number | null> {
  try {
    const cmd = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
    const m = cmd.match(/-Xmx(\d+)([kmg])/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
      return n * mult;
    }
  } catch {
    /* ignore */
  }
  return configuredHeapBytes();
}

/** Sample process state + metrics from the OS. `state` derives from presence. */
export async function sampleProcess(): Promise<ProcSample> {
  const pid = await findPzPid();
  if (!pid) {
    lastCpuSample = null;
    return { state: 'stopped', cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: null, uptimeSeconds: 0, source: 'proc' };
  }
  let cpuPercent: number | null = null;
  let memoryBytes: number | null = null;
  let uptimeSeconds: number | null = null;
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // Fields after "comm" (which may contain spaces) — split on last ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = parseInt(after[11], 10); // field 14
    const stime = parseInt(after[12], 10); // field 15
    const starttime = parseInt(after[19], 10); // field 22
    const jiffies = utime + stime;
    const now = Date.now();
    if (lastCpuSample && lastCpuSample.pid === pid) {
      const dJ = jiffies - lastCpuSample.jiffies;
      const dT = (now - lastCpuSample.at) / 1000;
      if (dT > 0) cpuPercent = Math.max(0, Math.round((dJ / (dT * CLK_TCK)) * 100));
    }
    lastCpuSample = { pid, jiffies, at: now };

    const uptimeSys = parseFloat((await fsp.readFile('/proc/uptime', 'utf8')).split(' ')[0]);
    uptimeSeconds = Math.max(0, Math.round(uptimeSys - starttime / CLK_TCK));

    // Real physical usage. Prefer PSS (smaps_rollup): PZ Build 42 runs ZGC,
    // which multi-maps the heap, so plain VmRSS can multi-count those pages.
    // PSS attributes each physical page once. Fall back to VmRSS when
    // smaps_rollup is unavailable. Never report the heap ceiling as usage.
    try {
      const rollup = await fsp.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = rollup.match(/^Pss:\s*(\d+)\s*kB/m);
      if (pss) memoryBytes = parseInt(pss[1], 10) * 1024;
    } catch {
      /* smaps_rollup unavailable; use VmRSS below */
    }
    if (memoryBytes == null) {
      const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
      const vm = status.match(/VmRSS:\s*(\d+)\s*kB/);
      if (vm) memoryBytes = parseInt(vm[1], 10) * 1024;
    }
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'proc metrics read failed');
  }
  return {
    state: 'running',
    cpuPercent,
    memoryBytes,
    memoryLimitBytes: await xmxLimitBytes(pid),
    uptimeSeconds,
    source: 'proc',
  };
}
