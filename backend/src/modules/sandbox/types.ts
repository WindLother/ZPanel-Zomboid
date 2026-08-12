/**
 * Canonical sandbox schema types. ONE schema owns field metadata (backend);
 * the frontend renders from what the API returns and never keeps its own copy.
 */

export type SandboxKind = 'enum' | 'toggle' | 'int' | 'float' | 'text';

export interface SandboxEnumOption {
  /** The value Project Zomboid stores (NOT necessarily a 1-based index). */
  value: number;
  label: string;
}

export interface SandboxFieldDef {
  /** Dotted SandboxVars path, e.g. "ZombieLore.Speed". Stable dirty-tracking id. */
  path: string;
  label: string;
  category: string;
  section: string;
  kind: SandboxKind;
  desc?: string;
  /** Project Zomboid's own "not recommended" advisory, when it marks one. */
  warning?: string;
  advanced?: boolean;
  options?: SandboxEnumOption[];
  min?: number;
  max?: number;
  /**
   * The GAME's default — informational only. Never used to populate the UI and
   * never written into the live file; current values come solely from the
   * server's own SandboxVars.lua.
   */
  default?: number | boolean | string;
}
