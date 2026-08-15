/**
 * Canonical server-settings schema types.
 *
 * ONE schema owns field metadata (backend); the frontend renders whatever the
 * API returns and never keeps its own copy — same contract as the sandbox
 * module (`modules/sandbox/types.ts`).
 *
 * The metadata itself is GENERATED from Project Zomboid's own comments in a
 * server-generated `<servername>.ini` — see scripts/generate-settings-schema.ts.
 * Values are never taken from the sample: the live server's ini is the only
 * source of current values.
 */

export type SettingKind = 'toggle' | 'int' | 'float' | 'text' | 'textarea' | 'enum';

export interface SettingEnumOption {
  /** The number Project Zomboid stores (NOT necessarily a 1-based index). */
  value: number;
  label: string;
}

/** Generated, PZ-authored metadata for one ini key. */
export interface SettingFieldDef {
  /** The real key in `<servername>.ini`. Also the canonical API/dirty-track id. */
  iniKey: string;
  label: string;
  /** Display group id — see `GROUP_ORDER` in categories.ts. */
  group: string;
  kind: SettingKind;
  desc?: string;
  options?: SettingEnumOption[];
  min?: number;
  max?: number;
  /**
   * Project Zomboid's own documented default — INFORMATIONAL ONLY. Never used
   * to populate the UI and never written to the live file.
   */
  default?: number | boolean | string;
}

/**
 * Hand-maintained policy per ini key, applied at runtime on top of the
 * generated metadata (so changing policy needs no regeneration).
 */
export interface SettingPolicy {
  /** Value is never returned to the browser; only a `configured` flag is. */
  secret?: boolean;
  /** Safely applicable at runtime via RCON `changeoption` + `reloadoptions`. */
  live?: boolean;
  /** Takes effect only after a server restart. */
  restart?: boolean;
  /** Operator-facing caution shown next to the field. */
  warning?: string;
  /** Force a rendering kind the generator cannot infer (e.g. empty samples). */
  kind?: SettingKind;
  /** Override the generated label. */
  label?: string;
  /** Override the generated max string length for text fields. */
  maxLength?: number;
}
