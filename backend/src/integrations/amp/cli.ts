import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { env } from '../../config/env';
import { err } from '../../shared/errors';

/**
 * AMP lifecycle via the official `ampinstmgr` CLI, run as the AMP system user.
 * This is NOT process management of our own — start/stop/restart/upgrade are
 * delegated to AMP's own tool, which owns the process (and its Docker
 * container). We never kill/spawn the Java game process directly.
 *
 * OS-level metrics moved to integrations/os/proc.ts (neutral infrastructure).
 */

function ampArgv(verb: string): { cmd: string; args: string[] } {
  // No instance default exists: the operator must name their own AMP instance.
  const inst = env.AMP_INSTANCE_NAME;
  if (!inst) throw err.amp('AMP_INSTANCE_NAME is not configured.');
  const base = [verb, inst];
  // Run as the AMP owner. If we already are that user, call directly.
  if (os.userInfo().username === env.AMP_SYSTEM_USER) {
    return { cmd: 'ampinstmgr', args: base };
  }
  return { cmd: 'sudo', args: ['-n', '-u', env.AMP_SYSTEM_USER, 'ampinstmgr', ...base] };
}

function run(verb: string, timeoutMs = 120_000): Promise<string> {
  if (!env.AMP_ALLOW_CLI) {
    return Promise.reject(err.amp('ampinstmgr fallback is disabled (AMP_ALLOW_CLI=false).'));
  }
  const { cmd, args } = ampArgv(verb);
  return new Promise((resolve, reject) => {
    // No shell: args is an argv array of literal verbs + the configured instance
    // name, so no browser value can influence the command.
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(err.amp(`ampinstmgr ${verb} timed out.`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (errOut += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(err.amp(`ampinstmgr not available: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(err.amp(`ampinstmgr ${verb} failed (exit ${code}): ${errOut || out}`.slice(0, 300)));
    });
  });
}

export const ampCli = {
  start: () => run('--StartInstance'),
  stop: () => run('--StopInstance'),
  restart: () => run('--RestartInstance'),
  upgrade: () => run('--UpgradeInstance'),
};

export function ampCliAvailable(): boolean {
  return env.AMP_ALLOW_CLI && (fs.existsSync('/usr/bin/ampinstmgr') || fs.existsSync('/usr/local/bin/ampinstmgr'));
}
