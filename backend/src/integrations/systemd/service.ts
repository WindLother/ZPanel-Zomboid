import { spawn } from 'node:child_process';
import os from 'node:os';
import { env } from '../../config/env';
import { err } from '../../shared/errors';

/**
 * Tightly-scoped systemd control for the ZPanel Project Zomboid unit.
 *
 * SECURITY: the unit name is FIXED from server-side config (env.SYSTEMD_UNIT) and
 * is NEVER derived from a request. The verbs are an internal allowlist. Commands
 * run via spawn with an argv array (no shell), so no request value can influence
 * the command line. Privileged verbs go through `sudo -n systemctl <verb>
 * <unit>`, which the deployment restricts to exactly these four commands.
 */

const UNIT = env.SYSTEMD_UNIT;
// Only these verbs may ever be issued. No arbitrary systemctl verbs.
const ALLOWED_VERBS = new Set(['start', 'stop', 'restart', 'status', 'is-active']);
// Query verbs do not need privilege; lifecycle verbs do.
const QUERY_VERBS = new Set(['status', 'is-active']);

function argvFor(verb: string): { cmd: string; args: string[] } {
  const base = ['systemctl', verb, UNIT];
  if (QUERY_VERBS.has(verb) || os.userInfo().username === 'root') {
    return { cmd: base[0], args: base.slice(1) };
  }
  // Privileged verb as a non-root user -> scoped, passwordless sudo.
  return { cmd: 'sudo', args: ['-n', ...base] };
}

function run(verb: string, timeoutMs: number): Promise<string> {
  if (!ALLOWED_VERBS.has(verb)) return Promise.reject(err.invalid(`Disallowed systemctl verb: ${verb}`));
  const { cmd, args } = argvFor(verb);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(err.amp(`systemctl ${verb} timed out.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (errOut += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(err.amp(`systemctl not available: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // is-active exits non-zero for inactive/failed but still prints the state.
      if (code === 0 || verb === 'is-active') resolve(out.trim() || errOut.trim());
      else reject(err.amp(`systemctl ${verb} failed (exit ${code}): ${(errOut || out).trim()}`.slice(0, 300)));
    });
  });
}

export type SystemdState = 'active' | 'activating' | 'deactivating' | 'inactive' | 'failed' | 'unknown';

export const systemdService = {
  unit: UNIT,
  start: () => run('start', 120_000),
  stop: () => run('stop', 180_000),
  restart: () => run('restart', 200_000),
  async isActive(): Promise<SystemdState> {
    let out: string;
    try {
      out = await run('is-active', 6_000);
    } catch (e) {
      out = e instanceof Error ? e.message : String(e);
    }
    const s = out.toLowerCase();
    for (const v of ['activating', 'deactivating', 'active', 'inactive', 'failed'] as const) {
      if (s.includes(v)) return v;
    }
    return 'unknown';
  },
};
