/**
 * Generate the server-settings schema from an AUTHORITATIVE, LOCALLY GENERATED
 * Project Zomboid `<servername>.ini`.
 *
 * Why this works: the dedicated server writes its ini with the option
 * documentation inline as `#` comments — a description, PZ's own
 * `Min: x Max: y Default: z` bounds, and (for a few keys) an inline enum legend
 * such as `1=Hidden 2=Friends` or `1 - ban, 2 - kick`. We parse those comments.
 *
 * Only METADATA is taken from the sample — NEVER its values. The live server's
 * ini remains the sole source of current values, and no sample value (least of
 * all a password) is ever emitted into the generated file.
 *
 * Usage:
 *   npx tsx scripts/generate-settings-schema.ts <servername.ini> [out.ts]
 *
 * The output (`src/modules/settings/schema.generated.ts`) is checked in;
 * re-run after a Project Zomboid update and review the diff. See AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { groupFor, labelFor, EXCLUDED_KEYS } from '../src/modules/settings/categories';
import type { SettingFieldDef, SettingKind, SettingEnumOption } from '../src/modules/settings/types';

/** `Min: 0.00 Max: 4.00 Default: 0.60` (also `Min: -1 Max: 36500 Default: 0`). */
const BOUNDS = /Min:\s*(-?[\d.]+)\s*Max:\s*(-?[\d.]+)(?:\s*Default:\s*(-?[\d.]+))?/i;
/** Inline legend, space separated: `1=Hidden 2=Friends 3=Friends and nearby`. */
const ENUM_EQ = /(?:^|\s)(\d+)\s*=\s*([^=]+?)(?=\s+\d+\s*=|$)/g;
/**
 * Inline legend, comma separated: `1 - ban, 2 - kick, 3 - record`. The first
 * entry usually follows a colon ("...in the chat: 1 - ban, 2 - kick"), so `:`
 * counts as a delimiter alongside `,`.
 */
const ENUM_DASH = /(?:^|[,:])\s*(\d+)\s*[-–]\s*([^,]+)/g;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseEnum(text: string): SettingEnumOption[] | undefined {
  const collect = (re: RegExp): SettingEnumOption[] => {
    const out: SettingEnumOption[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const label = m[2].replace(/[.;]$/, '').trim();
      if (label) out.push({ value: parseInt(m[1], 10), label });
    }
    return out;
  };
  // Require >= 2 entries so a stray "Default: 1" or "Min: 0" never reads as an enum.
  const eq = collect(ENUM_EQ);
  if (eq.length >= 2) return eq.sort((a, b) => a.value - b.value);
  const dash = collect(ENUM_DASH);
  if (dash.length >= 2) return dash.sort((a, b) => a.value - b.value);
  return undefined;
}

interface Meta {
  desc?: string;
  options?: SettingEnumOption[];
  min?: number;
  max?: number;
  defaultNum?: number;
  boundsSpelledFloat: boolean;
}

function parseComments(lines: string[]): Meta {
  const prose: string[] = [];
  let min: number | undefined;
  let max: number | undefined;
  let defaultNum: number | undefined;
  // PZ writes float bounds with decimals ("Min: 0.00 Max: 100000.00") and
  // integer bounds without. The RAW spelling is the type signal.
  let boundsSpelledFloat = false;
  let options: SettingEnumOption[] | undefined;

  for (const raw of lines) {
    let text = clean(raw);
    if (!text) continue;

    const bm = BOUNDS.exec(text);
    if (bm) {
      min = parseFloat(bm[1]);
      max = parseFloat(bm[2]);
      if (bm[3] !== undefined) defaultNum = parseFloat(bm[3]);
      if ([bm[1], bm[2], bm[3]].some((r) => r !== undefined && r.includes('.'))) boundsSpelledFloat = true;
      text = text.replace(BOUNDS, '').trim();
    }
    options = options ?? parseEnum(text);
    if (text) prose.push(text);
  }

  return {
    desc: prose.join(' ').trim() || undefined,
    options,
    min,
    max,
    defaultNum,
    boundsSpelledFloat,
  };
}

/** Decide the field kind from the sample literal + comment metadata. */
function classify(literal: string, meta: Meta): { kind: SettingKind; def?: number | boolean | string } {
  if (literal === 'true' || literal === 'false') return { kind: 'toggle' };
  if (meta.options) return { kind: 'enum', def: meta.defaultNum };
  if (literal !== '' && /^-?\d+$/.test(literal) && !meta.boundsSpelledFloat) {
    return { kind: 'int', def: meta.defaultNum };
  }
  if (literal !== '' && /^-?\d*\.\d+$/.test(literal)) return { kind: 'float', def: meta.defaultNum };
  // Bounds are the stronger signal: a float field whose sample happens to be whole.
  if (meta.boundsSpelledFloat) return { kind: 'float', def: meta.defaultNum };
  if (meta.min !== undefined && literal !== '' && /^-?\d+$/.test(literal)) return { kind: 'int', def: meta.defaultNum };
  // Empty sample -> the kind cannot be inferred; POLICY declares it (see categories.ts).
  return { kind: 'text' };
}

function generate(source: string): SettingFieldDef[] {
  const fields: SettingFieldDef[] = [];
  let comments: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      comments.push(s.replace(/^#\s?/, ''));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=(.*)$/.exec(s);
    if (!kv) {
      comments = [];
      continue;
    }
    const iniKey = kv[1];
    const literal = kv[2].trim();
    const pending = comments;
    comments = [];

    if (EXCLUDED_KEYS.has(iniKey)) continue; // Mods/WorkshopItems belong to the Mods page

    const meta = parseComments(pending);
    const { kind, def } = classify(literal, meta);

    fields.push({
      iniKey,
      label: labelFor(iniKey),
      group: groupFor(iniKey),
      kind,
      ...(meta.desc ? { desc: meta.desc } : {}),
      ...(meta.options ? { options: meta.options } : {}),
      ...(meta.min !== undefined ? { min: meta.min } : {}),
      ...(meta.max !== undefined ? { max: meta.max } : {}),
      ...(def !== undefined ? { default: def } : {}),
    });
  }
  return fields;
}

function emit(fields: SettingFieldDef[], sourceName: string): string {
  const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Project Zomboid server-settings schema, generated by
 * scripts/generate-settings-schema.ts from a dedicated-server generated
 * <servername>.ini (source sample: ${sourceName}). Descriptions, bounds and
 * enum legends are Project Zomboid's own, read from that file's comments.
 *
 * Only METADATA is taken from the sample — never its values. Grouping, labels,
 * secrets and restart/live semantics live in ./categories.ts.
 *
 * Regenerate after a Project Zomboid update and review the diff. See AGENTS.md.
 */
import type { SettingFieldDef } from './types';

export const SETTINGS_SCHEMA_SOURCE =
  'Project Zomboid Build 42 generated <servername>.ini (server-authored comments)';

export const SETTINGS_SCHEMA: SettingFieldDef[] = [
`;
  const body = fields.map((f) => '  ' + JSON.stringify(f) + ',').join('\n');
  return header + body + '\n];\n';
}

const [, , input, output] = process.argv;
if (!input) {
  // eslint-disable-next-line no-console
  console.error('Usage: tsx scripts/generate-settings-schema.ts <servername.ini> [out.ts]');
  process.exit(1);
}
const fields = generate(fs.readFileSync(input, 'utf8'));
const out = output || path.join(__dirname, '..', 'src', 'modules', 'settings', 'schema.generated.ts');
fs.writeFileSync(out, emit(fields, path.basename(input)));
// eslint-disable-next-line no-console
console.log(`Generated ${fields.length} settings fields -> ${out}`);
