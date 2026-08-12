import { readSandbox, writeSandbox } from '../../integrations/zomboid-files/service';
import type { LuaScalar } from '../../integrations/zomboid-files/sandbox';
import { err } from '../../shared/errors';
import { SANDBOX_FIELDS, SANDBOX_BY_PATH, enumToLabel, labelToEnum } from './mapping';
import { CATEGORY_ORDER } from './categories';

/**
 * Sandbox settings. READ maps the real SandboxVars values onto the generated
 * Build 42 schema (categories, labels, enum legends, PZ's own bounds and
 * advisories). WRITE validates each changed field against that schema, maps
 * labels back to numbers, and patches ONLY those values — every other sandbox
 * key (unknown vanilla options, future options, mod sections, comments) is
 * preserved byte-for-byte by the splicing writer.
 *
 * Two invariants worth stating outright:
 *  - A schema `default` is INFORMATIONAL. Values shown always come from the
 *    server's own SandboxVars.lua.
 *  - A field the live file does not contain is NOT emitted and NOT written;
 *    absence means "whatever Project Zomboid does by default".
 */

export interface SandboxField {
  key: string; // dotted path — the stable id used for dirty tracking
  label: string;
  type: 'select' | 'number' | 'toggle' | 'text';
  value: unknown;
  options?: readonly string[];
  desc?: string;
  warning?: string;
  advanced?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** The game's default, for display only — never auto-applied. */
  default?: unknown;
}
export interface SandboxSection {
  id: string;
  title: string;
  fields: SandboxField[];
}
export interface SandboxCategory {
  name: string;
  sections: SandboxSection[];
}

const sectionId = (category: string, section: string): string =>
  `${category}/${section}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export async function getSandbox(): Promise<SandboxCategory[]> {
  const parsed = await readSandbox();
  const categories = new Map<string, Map<string, SandboxSection>>();

  for (const def of SANDBOX_FIELDS) {
    const raw = parsed.values[def.path];
    if (raw === undefined) continue; // absent on this server -> PZ default behavior; never invented
    if (!categories.has(def.category)) categories.set(def.category, new Map());
    const sections = categories.get(def.category)!;
    const id = sectionId(def.category, def.section);
    if (!sections.has(id)) sections.set(id, { id, title: def.section, fields: [] });

    const common = {
      key: def.path,
      label: def.label,
      desc: def.desc,
      warning: def.warning,
      advanced: def.advanced,
      default: def.default,
    };

    let field: SandboxField;
    if (def.kind === 'enum' && def.options) {
      field = { ...common, type: 'select', options: def.options.map((o) => o.label), value: enumToLabel(def.options, raw) };
    } else if (def.kind === 'toggle') {
      field = { ...common, type: 'toggle', value: Boolean(raw) };
    } else if (def.kind === 'text') {
      field = { ...common, type: 'text', value: String(raw) };
    } else {
      field = {
        ...common,
        type: 'number',
        value: raw,
        min: def.min,
        max: def.max,
        step: def.kind === 'float' ? 0.01 : 1,
      };
    }
    sections.get(id)!.fields.push(field);
  }

  const out = [...categories.entries()].map(([name, sections]) => ({ name, sections: [...sections.values()] }));
  const rank = (n: string): number => {
    const i = CATEGORY_ORDER.indexOf(n);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

interface IncomingField {
  key: string;
  value: unknown;
}

function flatten(payload: unknown): IncomingField[] {
  const out: IncomingField[] = [];
  if (Array.isArray(payload)) {
    for (const cat of payload) {
      for (const sec of (cat as SandboxCategory)?.sections ?? []) {
        for (const f of sec?.fields ?? []) {
          if (f && typeof f.key === 'string') out.push({ key: f.key, value: f.value });
        }
      }
    }
  } else if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) out.push({ key, value });
  }
  return out;
}

/**
 * Validate one incoming value against its schema definition. Backend validation
 * is authoritative: a request that bypasses the UI is held to the same bounds.
 */
function coerce(def: NonNullable<ReturnType<typeof SANDBOX_BY_PATH.get>>, value: unknown): LuaScalar {
  if (def.kind === 'enum' && def.options) {
    if (typeof value === 'number') {
      if (!def.options.some((o) => o.value === value)) {
        throw err.invalid(`${def.label}: invalid selection.`, { path: def.path });
      }
      return value;
    }
    if (typeof value !== 'string') throw err.invalid(`${def.label} must be a selection.`, { path: def.path });
    return labelToEnum(def.options, value);
  }
  if (def.kind === 'toggle') {
    if (typeof value === 'string') return value === 'true';
    return Boolean(value);
  }
  if (def.kind === 'text') {
    if (typeof value !== 'string') throw err.invalid(`${def.label} must be text.`, { path: def.path });
    if (value.length > 8192) throw err.invalid(`${def.label} is too long.`, { path: def.path });
    return value; // empty string stays an empty string — never coerced to null
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw err.invalid(`${def.label} must be a number.`, { path: def.path });
  if (def.kind === 'int' && !Number.isInteger(n)) {
    throw err.invalid(`${def.label} must be a whole number.`, { path: def.path });
  }
  if (def.min != null && n < def.min) {
    throw err.invalid(`${def.label} must be at least ${def.min}.`, { path: def.path, min: def.min });
  }
  if (def.max != null && n > def.max) {
    throw err.invalid(`${def.label} must be at most ${def.max}.`, { path: def.path, max: def.max });
  }
  return n;
}

export async function saveSandbox(
  payload: unknown,
): Promise<{ saved: boolean; applied: string[]; restartRequired: boolean; categories: SandboxCategory[] }> {
  const incoming = flatten(payload);
  const current = await readSandbox();
  const patch: Record<string, LuaScalar> = {};

  for (const { key, value } of incoming) {
    const def = SANDBOX_BY_PATH.get(key);
    if (!def) continue; // unknown key: ignored, and left untouched in the file
    if (current.values[key] === undefined) continue; // not present in the file: never introduced
    const next = coerce(def, value);
    if (next === current.values[key]) continue; // unchanged: keep the patch minimal
    patch[def.path] = next;
  }

  const applied = Object.keys(patch);
  if (applied.length > 0) await writeSandbox(patch);
  return {
    saved: true,
    applied,
    // SandboxVars are read by Project Zomboid at startup; a write lands on disk
    // but does not affect the running world.
    restartRequired: applied.length > 0,
    categories: await getSandbox(),
  };
}
