/**
 * Generate the Build 42 sandbox schema from an AUTHORITATIVE, LOCALLY GENERATED
 * Project Zomboid `*_SandboxVars.lua`.
 *
 * Why this works: the dedicated server writes its SandboxVars file with the full
 * option metadata inline as `--` comments — a description, PZ's own
 * `Min: x Max: y Default: z` bounds, the numeric enum legend (`-- 1 = Insane`),
 * and its "do not change this" advisory markup (`<BHC> [!] ... [!] <RGB:r,g,b>`).
 * We parse those comments; we NEVER execute Lua and we NEVER import the sample
 * file's VALUES (those are one server's gameplay config, not defaults).
 *
 * Usage:
 *   npx tsx scripts/generate-sandbox-schema.ts <SandboxVars.lua> [out.ts]
 *
 * The output (`src/modules/sandbox/schema.generated.ts`) is checked in; re-run
 * this after a Project Zomboid update and review the diff. See AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { categoryFor, labelFor } from '../src/modules/sandbox/categories';

type Kind = 'enum' | 'toggle' | 'int' | 'float' | 'text';

interface Field {
  path: string;
  label: string;
  category: string;
  section: string;
  kind: Kind;
  desc?: string;
  warning?: string;
  advanced?: boolean;
  options?: Array<{ value: number; label: string }>;
  min?: number;
  max?: number;
  default?: number | boolean | string;
}

/** Strip PZ's colour/markup tokens from a comment line. */
function clean(text: string): string {
  return text
    .replace(/<BHC>/g, '')
    .replace(/<RGB:[^>]*>/g, '')
    .replace(/<LINE>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `Min: 0.00 Max: 4.00 Default: 0.60` (also `Min: -1 Max: 36500 Default: 0`). */
const BOUNDS = /Min:\s*(-?[\d.]+)\s*Max:\s*(-?[\d.]+)(?:\s*Default:\s*(-?[\d.]+))?/i;
/** A legend line that is exactly `-- <n> = <label>`. */
const ENUM_LINE = /^(\d+)\s*=\s*(.+?)$/;
/** `Default = Normal` inside a prose line (enum default, by label). */
const DEFAULT_LABEL = /Default\s*=\s*(.+?)\s*$/i;

function parseComments(lines: string[]): {
  desc?: string;
  warning?: string;
  boundsSpelledFloat: boolean;
  options?: Array<{ value: number; label: string }>;
  min?: number;
  max?: number;
  defaultNum?: number;
  defaultLabel?: string;
} {
  const options: Array<{ value: number; label: string }> = [];
  const prose: string[] = [];
  let min: number | undefined;
  let max: number | undefined;
  let defaultNum: number | undefined;
  let defaultLabel: string | undefined;
  let warning: string | undefined;
  // PZ writes float bounds with decimals ("Min: 0.00 Max: 1000.00") and integer
  // bounds without ("Min: -1 Max: 36500"). The RAW spelling is the type signal —
  // parsing first would make 0.00 indistinguishable from 0.
  let boundsSpelledFloat = false;

  for (const raw of lines) {
    const isWarning = raw.includes('<BHC>');
    const text = clean(raw);
    if (!text) continue;

    const em = ENUM_LINE.exec(text);
    if (em) {
      options.push({ value: parseInt(em[1], 10), label: em[2].trim() });
      continue;
    }

    let rest = text;
    const bm = BOUNDS.exec(rest);
    if (bm) {
      min = parseFloat(bm[1]);
      max = parseFloat(bm[2]);
      if (bm[3] !== undefined) defaultNum = parseFloat(bm[3]);
      if ([bm[1], bm[2], bm[3]].some((r) => r !== undefined && r.includes('.'))) boundsSpelledFloat = true;
      rest = rest.replace(BOUNDS, '').trim();
    }
    const dm = DEFAULT_LABEL.exec(rest);
    if (dm && !bm) {
      defaultLabel = dm[1].trim();
      rest = rest.replace(DEFAULT_LABEL, '').trim();
    }
    if (isWarning) {
      // Everything up to the trailing colour reset is PZ's advisory text.
      warning = rest.replace(/\[!\]/g, '').replace(/\s+/g, ' ').trim() || warning;
    } else if (rest) {
      prose.push(rest);
    }
  }

  const desc = prose.join(' ').trim() || undefined;
  return {
    desc,
    warning,
    boundsSpelledFloat,
    options: options.length ? options.sort((a, b) => a.value - b.value) : undefined,
    min,
    max,
    defaultNum,
    defaultLabel,
  };
}

/** Decide the field kind from the sample literal + the comment metadata. */
function classify(
  literal: string,
  meta: ReturnType<typeof parseComments>,
): { kind: Kind; def?: number | boolean | string } {
  if (literal === 'true' || literal === 'false') {
    return { kind: 'toggle', def: undefined };
  }
  if (/^".*"$/s.test(literal)) return { kind: 'text' };
  if (meta.options) {
    // Enum default is given by LABEL; resolve it to its numeric value.
    const hit = meta.defaultLabel
      ? meta.options.find((o) => o.label.toLowerCase() === meta.defaultLabel!.toLowerCase())
      : undefined;
    return { kind: 'enum', def: hit?.value ?? meta.defaultNum };
  }
  // Float when PZ's own bounds are written with decimals, else when the sample
  // literal is fractional. (Bounds are the stronger signal: `Global = 10` is a
  // float field whose sample value happens to be whole.)
  const literalIsFloat = /\./.test(literal);
  const kind: Kind = meta.boundsSpelledFloat || literalIsFloat ? 'float' : 'int';
  return { kind, def: meta.defaultNum };
}

function generate(source: string): Field[] {
  const lines = source.split(/\r?\n/);
  const fields: Field[] = [];
  const stack: string[] = [];
  let comments: string[] = [];

  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    if (s.startsWith('--')) {
      comments.push(s.replace(/^--\s?/, ''));
      continue;
    }
    const open = /^([A-Za-z_]\w*)\s*=\s*\{/.exec(s);
    if (open) {
      stack.push(open[1]);
      comments = [];
      continue;
    }
    if (s.startsWith('}')) {
      stack.pop();
      comments = [];
      continue;
    }
    const kv = /^([A-Za-z_]\w*)\s*=\s*(.+?),?\s*$/.exec(s);
    if (!kv) {
      comments = [];
      continue;
    }
    const key = kv[1];
    const literal = kv[2].replace(/,$/, '').trim();
    // stack[0] is the `SandboxVars` root itself.
    const prefix = stack.slice(1).join('.');
    const full = prefix ? `${prefix}.${key}` : key;
    const pending = comments;
    comments = [];

    if (full === 'VERSION') continue; // file-format marker, never an editable setting

    const meta = parseComments(pending);
    const { kind, def } = classify(literal, meta);
    const { category, section } = categoryFor(full);

    fields.push({
      path: full,
      label: labelFor(full),
      category,
      section,
      kind,
      ...(meta.desc ? { desc: meta.desc } : {}),
      ...(meta.warning ? { warning: meta.warning, advanced: true } : {}),
      ...(meta.options ? { options: meta.options } : {}),
      ...(meta.min !== undefined ? { min: meta.min } : {}),
      ...(meta.max !== undefined ? { max: meta.max } : {}),
      ...(def !== undefined ? { default: def } : {}),
    });
  }
  return fields;
}

function emit(fields: Field[], sourceName: string): string {
  const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Build 42 sandbox option schema, generated by scripts/generate-sandbox-schema.ts
 * from a Project Zomboid dedicated-server generated SandboxVars.lua
 * (source sample: ${sourceName}). Descriptions, bounds, enum legends and the
 * "not recommended" advisories are Project Zomboid's own, read from that file's
 * comments. Only METADATA is taken from the sample — never its values: the live
 * server's SandboxVars.lua remains the sole source of current values.
 *
 * Regenerate after a Project Zomboid update and review the diff. See AGENTS.md.
 */
import type { SandboxFieldDef } from './types';

export const SCHEMA_SOURCE = 'Project Zomboid Build 42 generated SandboxVars.lua (server-authored comments)';

export const SANDBOX_SCHEMA: SandboxFieldDef[] = [
`;
  const body = fields
    .map((f) => '  ' + JSON.stringify(f) + ',')
    .join('\n');
  return header + body + '\n];\n';
}

const [, , input, output] = process.argv;
if (!input) {
  // eslint-disable-next-line no-console
  console.error('Usage: tsx scripts/generate-sandbox-schema.ts <SandboxVars.lua> [out.ts]');
  process.exit(1);
}
const src = fs.readFileSync(input, 'utf8');
const fields = generate(src);
const out = output || path.join(__dirname, '..', 'src', 'modules', 'sandbox', 'schema.generated.ts');
fs.writeFileSync(out, emit(fields, path.basename(input)));
// eslint-disable-next-line no-console
console.log(`Generated ${fields.length} sandbox fields -> ${out}`);
