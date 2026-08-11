/**
 * Server console allowlist. This console targets the Project Zomboid game
 * console via RCON — NEVER a shell. The browser may only submit a command whose
 * first token is on this list; everything else is rejected. Destructive
 * lifecycle commands (notably `quit`) are intentionally excluded and handled by
 * dedicated lifecycle endpoints instead.
 */

// Commands confirmed available on this Build 42 server (from live `help`).
export const CONSOLE_ALLOWED = new Set<string>([
  'players',
  'save',
  'servermsg',
  'help',
  'showoptions',
  'stats',
  'checkmodsneedupdate',
  'reloadoptions',
  'alarm',
  'chopper',
  'gunshot',
  'lightning',
  'thunder',
  'createhorde',
  'removezombies',
  'additem',
  'addxp',
  'adduser',
  'kickuser',
  'banuser',
  'unbanuser',
  'setaccesslevel',
  'startrain',
  'stoprain',
  'startstorm',
  'stopweather',
  'teleport',
  'voiceban',
]);

// Only these characters may appear in a console line (defense in depth — RCON has
// no shell/quoting to exploit, but we still reject control chars and pipes/etc.).
const SAFE_LINE = /^[A-Za-z0-9_.,;:=\-"' /]+$/;

export function validateConsoleLine(line: string): { name: string; command: string } {
  const command = line.trim();
  if (!command) {
    const e = new Error('Empty command.');
    (e as { code?: string }).code = 'INVALID_INPUT';
    throw e;
  }
  if (command.length > 200) throw invalid('Command is too long.');
  if (!SAFE_LINE.test(command)) throw invalid('Command contains disallowed characters.');
  const name = command.split(/\s+/)[0].toLowerCase();
  if (!CONSOLE_ALLOWED.has(name)) throw invalid(`Command "${name}" is not permitted.`);
  return { name, command };
}

function invalid(message: string): Error {
  const e = new Error(message);
  (e as { code?: string }).code = 'INVALID_INPUT';
  return e;
}
