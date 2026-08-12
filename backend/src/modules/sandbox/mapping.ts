import { err } from '../../shared/errors';
import type { LuaScalar } from '../../integrations/zomboid-files/sandbox';
import type { SandboxEnumOption, SandboxFieldDef } from './types';
import { SANDBOX_SCHEMA } from './schema.generated';

/**
 * Sandbox enum mapping. Project Zomboid stores most sandbox options as numeric
 * enums; the UI shows human labels. The legends come from the generated schema
 * (Project Zomboid's own SandboxVars.lua comments) as explicit {value,label}
 * pairs — NOT an index-position assumption — so a future non-contiguous enum
 * keeps mapping correctly.
 *
 * Any sandbox key absent from the schema is left untouched on save.
 */

export const SANDBOX_FIELDS: SandboxFieldDef[] = SANDBOX_SCHEMA;
export const SANDBOX_BY_PATH = new Map(SANDBOX_FIELDS.map((f) => [f.path, f]));

/** Stored numeric value -> label. Unknown values render as their raw number. */
export function enumToLabel(options: readonly SandboxEnumOption[], value: LuaScalar): string {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return options.find((o) => o.value === n)?.label ?? String(value);
}

/** Label -> stored numeric value. Throws on an unknown label. */
export function labelToEnum(options: readonly SandboxEnumOption[], label: string): number {
  const hit = options.find((o) => o.label === label);
  if (!hit) throw err.invalid(`Invalid value "${label}".`, { allowed: options.map((o) => o.label) });
  return hit.value;
}
