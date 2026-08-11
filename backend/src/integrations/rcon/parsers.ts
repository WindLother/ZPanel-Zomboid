/**
 * Parsers for real Project Zomboid RCON responses. Built from live output
 * captured on this server (Build 42). Deliberately tolerant of whitespace and
 * count/label variations — never dependent on an exact mock string.
 */

export interface ParsedPlayers {
  count: number;
  usernames: string[];
}

/**
 * `players` output looks like:
 *   "Players connected (0): \n"
 *   "Players connected (2): \nAlice\nBob\n"   (names newline- or comma-separated)
 * Some builds print a leading "-" bullet per name. We accept both forms.
 */
export function parsePlayers(raw: string): ParsedPlayers {
  const text = raw.replace(/\r/g, '');
  const header = text.match(/Players connected\s*\((\d+)\)\s*:?/i);
  const declared = header ? parseInt(header[1], 10) : NaN;

  // Everything after the header colon is the (possibly empty) name list.
  let body = text;
  if (header) body = text.slice(text.indexOf(header[0]) + header[0].length);

  const usernames = body
    .split(/[\n,]/)
    .map((s) => s.replace(/^[-*\s]+/, '').trim())
    .filter((s) => s.length > 0 && !/^players connected/i.test(s));

  const count = Number.isFinite(declared) ? declared : usernames.length;
  return { count, usernames };
}

/**
 * `save` returns free-form text on success (e.g. "World saved"). Treat any
 * non-error response as success; surface obvious failure keywords.
 */
export function parseSaveResult(raw: string): { ok: boolean; message: string } {
  const message = raw.trim();
  const ok = message.length === 0 || !/error|fail|exception|not\s+online/i.test(message);
  return { ok, message: message || 'World saved.' };
}

/** Parse the `help` command into { name, description } entries. */
export function parseHelp(raw: string): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*\*\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (m) out.push({ name: m[1], description: m[2].trim() });
  }
  return out;
}

/**
 * `checkModsNeedUpdate` acknowledges over RCON and writes the real result to the
 * DebugLog; parse the acknowledgement so callers know it was accepted.
 */
export function parseCheckModsAck(raw: string): { accepted: boolean; message: string } {
  const message = raw.trim();
  return { accepted: !/error|unknown command/i.test(message), message };
}
