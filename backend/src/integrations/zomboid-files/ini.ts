/**
 * Structure-preserving parser/patcher for Project Zomboid `.ini` files
 * (`Key=Value`, `# comment`, blank lines). Patching updates only the requested
 * keys in place and appends genuinely new keys — comments, ordering, and any
 * settings the panel does not know about are preserved verbatim.
 */

export type IniLine =
  | { kind: 'kv'; key: string; value: string; raw: string }
  | { kind: 'comment'; raw: string }
  | { kind: 'blank'; raw: string };

export interface ParsedIni {
  lines: IniLine[];
  values: Record<string, string>;
}

export function parseIni(text: string): ParsedIni {
  const lines: IniLine[] = [];
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      lines.push({ kind: 'blank', raw });
    } else if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      lines.push({ kind: 'comment', raw });
    } else {
      const eq = raw.indexOf('=');
      if (eq === -1) {
        // Not a recognizable key=value; keep as an opaque comment-like line.
        lines.push({ kind: 'comment', raw });
        continue;
      }
      const key = raw.slice(0, eq).trim();
      const value = raw.slice(eq + 1);
      lines.push({ kind: 'kv', key, value, raw });
      values[key] = value;
    }
  }
  return { lines, values };
}

/**
 * Return a new INI text with `patch` applied. Keys present in the file are
 * updated in place (preserving the key's original spelling); unknown keys are
 * appended. Values are written verbatim — callers must validate them first.
 */
export function patchIni(text: string, patch: Record<string, string>): string {
  const { lines } = parseIni(text);
  const applied = new Set<string>();
  const trailingNewline = text.endsWith('\n');

  const out = lines.map((line) => {
    if (line.kind !== 'kv') return line.raw;
    if (Object.prototype.hasOwnProperty.call(patch, line.key)) {
      applied.add(line.key);
      return `${line.key}=${patch[line.key]}`;
    }
    return line.raw;
  });

  for (const [key, value] of Object.entries(patch)) {
    if (!applied.has(key)) out.push(`${key}=${value}`);
  }

  let result = out.join('\n');
  if (trailingNewline && !result.endsWith('\n')) result += '\n';
  return result;
}
