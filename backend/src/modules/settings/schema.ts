import { z } from 'zod';
import { err } from '../../shared/errors';
import { SETTINGS_SCHEMA } from './schema.generated';
import { GROUPS, POLICY, EXTRA_FIELDS, EXCLUDED_KEYS, groupFor, labelFor } from './categories';
import type { SettingFieldDef, SettingKind } from './types';

/**
 * Allowlisted server settings. The browser can only write keys defined here,
 * and only values that pass this module's per-kind validation. Everything else
 * in `<servername>.ini` is preserved untouched (patch semantics).
 *
 * The field metadata is GENERATED from Project Zomboid's own ini comments
 * (`schema.generated.ts`); grouping, labels, secrets and restart/live semantics
 * are hand-maintained in `categories.ts`. This file joins the two and attaches
 * the validators.
 *
 * This is an ALLOWLIST, not an arbitrary ini editor: a key absent here is never
 * written, and `Mods` / `WorkshopItems` are deliberately excluded because the
 * Mods page owns them (AGENTS.md §9).
 */

export type FieldType = 'text' | 'textarea' | 'number' | 'toggle' | 'select';

export interface SettingDef {
  key: string; // canonical key — identical to iniKey
  iniKey: string; // real key in <servername>.ini
  label: string;
  desc?: string;
  type: FieldType;
  group: { id: string; title: string };
  /** parse ini string -> frontend value */
  fromIni: (raw: string | undefined) => unknown;
  /** validate a frontend value and return the ini string to persist */
  toIni: (value: unknown) => string;
  restart?: boolean; // requires a server restart to take effect
  live?: boolean; // safely applicable at runtime via changeoption+reloadoptions
  secret?: boolean;
  /** Operator-facing caution (destructive or self-locking changes). */
  warning?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Enum choices, as display labels (the ini stores the matching number). */
  options?: string[];
}

const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
const groupOf = (id: string): { id: string; title: string } => GROUP_BY_ID.get(id) ?? { id: 'advanced', title: 'Advanced' };

/** Newlines/CR would split one ini entry into two — never allow them through. */
const safeText = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .refine((v) => !/[\r\n]/.test(v), { message: 'Value may not contain line breaks.' });

const TYPE_BY_KIND: Record<SettingKind, FieldType> = {
  toggle: 'toggle',
  int: 'number',
  float: 'number',
  text: 'text',
  textarea: 'textarea',
  enum: 'select',
};

function buildDef(meta: SettingFieldDef): SettingDef {
  const policy = POLICY[meta.iniKey] ?? {};
  const kind: SettingKind = policy.kind ?? meta.kind;
  const label = policy.label ?? meta.label;

  // Default to restart-required. `live` is only ever claimed where a runtime
  // changeoption is known to work — reporting a change as applied when it was
  // not would be fabricated data (AGENTS.md §1 rule 18).
  const restart = policy.live ? undefined : (policy.restart ?? true);

  const base = {
    key: meta.iniKey,
    iniKey: meta.iniKey,
    label,
    type: TYPE_BY_KIND[kind],
    group: groupOf(meta.group),
    ...(meta.desc ? { desc: meta.desc } : {}),
    ...(restart ? { restart: true } : {}),
    ...(policy.live ? { live: true } : {}),
    ...(policy.secret ? { secret: true } : {}),
    ...(policy.warning ? { warning: policy.warning } : {}),
  };

  if (kind === 'toggle') {
    return {
      ...base,
      fromIni: (raw) => String(raw).toLowerCase() === 'true',
      // NB: z.coerce.boolean() is useless here - Boolean('false') is true.
      toIni: (v) => {
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase();
        throw err.invalid(`${label} must be true or false.`, { key: meta.iniKey });
      },
    };
  }

  if (kind === 'enum') {
    const options = meta.options ?? [];
    const labels = options.map((o) => o.label);
    return {
      ...base,
      options: labels,
      fromIni: (raw) => {
        const n = Number(raw);
        return options.find((o) => o.value === n)?.label ?? (raw ?? '');
      },
      toIni: (v) => {
        // Accept either the display label (what the UI sends) or the raw number.
        if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v))) {
          const n = Number(v);
          if (!options.some((o) => o.value === n)) {
            throw err.invalid(`${label}: invalid selection.`, { key: meta.iniKey });
          }
          return String(n);
        }
        const hit = options.find((o) => o.label === v);
        if (!hit) throw err.invalid(`${label}: invalid selection.`, { key: meta.iniKey });
        return String(hit.value);
      },
    };
  }

  if (kind === 'int' || kind === 'float') {
    const min = meta.min;
    const max = meta.max;
    let num = kind === 'int' ? z.coerce.number().int() : z.coerce.number();
    if (min !== undefined) num = num.min(min);
    if (max !== undefined) num = num.max(max);
    return {
      ...base,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      step: kind === 'float' ? 0.01 : 1,
      fromIni: (raw) => (raw === undefined || raw === '' ? 0 : Number(raw)),
      toIni: (v) => String(num.parse(v)),
    };
  }

  // text / textarea
  const maxLength = policy.maxLength ?? (kind === 'textarea' ? 4000 : 500);
  return {
    ...base,
    fromIni: (raw) => raw ?? '',
    toIni: (v) => safeText(maxLength).parse(v),
  };
}

const EXTRA_DEFS: SettingFieldDef[] = EXTRA_FIELDS.map((f) => ({
  iniKey: f.iniKey,
  label: labelFor(f.iniKey),
  group: groupFor(f.iniKey),
  kind: f.kind,
  ...(f.desc ? { desc: f.desc } : {}),
  ...(f.min !== undefined ? { min: f.min } : {}),
  ...(f.max !== undefined ? { max: f.max } : {}),
}));

const ALL_META: SettingFieldDef[] = [...SETTINGS_SCHEMA, ...EXTRA_DEFS].filter((m) => !EXCLUDED_KEYS.has(m.iniKey));

/** Ordered by the group order in categories.ts, then by generated order. */
const GROUP_RANK = new Map(GROUPS.map((g, i) => [g.id, i]));
export const SETTINGS: SettingDef[] = ALL_META.map(buildDef).sort(
  (a, b) => (GROUP_RANK.get(a.group.id) ?? 99) - (GROUP_RANK.get(b.group.id) ?? 99),
);

/**
 * Lookup by canonical key. Keys are the ini key names; the three legacy
 * frontend aliases used before the schema covered the whole file are still
 * accepted so an older cached page cannot silently drop a field on save.
 */
const LEGACY_ALIASES: Record<string, string> = {
  ServerName: 'PublicName',
  Description: 'PublicDescription',
  AutoCreateUser: 'AutoCreateUserInWhiteList',
};

export const SETTINGS_BY_KEY = new Map<string, SettingDef>(SETTINGS.map((s) => [s.key, s]));
for (const [alias, target] of Object.entries(LEGACY_ALIASES)) {
  const def = SETTINGS_BY_KEY.get(target);
  if (def) SETTINGS_BY_KEY.set(alias, def);
}
