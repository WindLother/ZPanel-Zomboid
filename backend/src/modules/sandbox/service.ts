import { readSandbox, writeSandbox } from '../../integrations/zomboid-files/service';
import type { LuaScalar } from '../../integrations/zomboid-files/sandbox';
import { err } from '../../shared/errors';
import { SANDBOX_FIELDS, SANDBOX_BY_PATH, enumToLabel, labelToEnum } from './mapping';

/**
 * Sandbox settings. READ maps the real numeric SandboxVars to the frontend's
 * categorized, human-labeled model. WRITE validates each changed field, maps
 * labels back to numbers, and patches ONLY those values — every other sandbox
 * key (including ones the panel does not expose) is preserved byte-for-byte.
 */

export interface SandboxField {
  key: string; // path
  label: string;
  type: 'select' | 'number' | 'toggle';
  value: unknown;
  options?: readonly string[];
  desc?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
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

export async function getSandbox(): Promise<SandboxCategory[]> {
  const parsed = await readSandbox();
  const categories = new Map<string, Map<string, SandboxSection>>();

  for (const def of SANDBOX_FIELDS) {
    const raw = parsed.values[def.path];
    if (raw === undefined) continue; // not present on this server; skip silently
    if (!categories.has(def.category)) categories.set(def.category, new Map());
    const sections = categories.get(def.category)!;
    if (!sections.has(def.section.id)) sections.set(def.section.id, { id: def.section.id, title: def.section.title, fields: [] });

    let field: SandboxField;
    if (def.kind === 'enum' && def.options) {
      field = { key: def.path, label: def.label, type: 'select', options: def.options, value: enumToLabel(def.options, raw), desc: def.desc };
    } else if (def.kind === 'toggle') {
      field = { key: def.path, label: def.label, type: 'toggle', value: Boolean(raw), desc: def.desc };
    } else {
      field = { key: def.path, label: def.label, type: 'number', value: raw, min: def.min, max: def.max, step: def.step, unit: def.unit, desc: def.desc };
    }
    sections.get(def.section.id)!.fields.push(field);
  }

  return [...categories.entries()].map(([name, sections]) => ({ name, sections: [...sections.values()] }));
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

export async function saveSandbox(payload: unknown): Promise<{ saved: boolean; applied: string[]; categories: SandboxCategory[] }> {
  const incoming = flatten(payload);
  const patch: Record<string, LuaScalar> = {};

  for (const { key, value } of incoming) {
    const def = SANDBOX_BY_PATH.get(key);
    if (!def) continue; // ignore unknown keys
    if (def.kind === 'enum' && def.options) {
      if (typeof value !== 'string') throw err.invalid(`${def.label} must be a selection.`);
      patch[def.path] = labelToEnum(def.options, value);
    } else if (def.kind === 'toggle') {
      patch[def.path] = Boolean(value);
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) throw err.invalid(`${def.label} must be a number.`);
      if (def.min != null && n < def.min) throw err.invalid(`${def.label} is below the minimum.`);
      if (def.max != null && n > def.max) throw err.invalid(`${def.label} is above the maximum.`);
      patch[def.path] = n;
    }
  }

  if (Object.keys(patch).length > 0) await writeSandbox(patch);
  return { saved: true, applied: Object.keys(patch), categories: await getSandbox() };
}
