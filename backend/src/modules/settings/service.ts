import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { runtime } from '../../integrations/runtime';
import { readServerIni, writeServerIni } from '../../integrations/zomboid-files/service';
import { logger } from '../../shared/logger';
import { SETTINGS, SETTINGS_BY_KEY, type SettingDef } from './schema';

/**
 * Server settings. READ builds the frontend group model from the real
 * servertest.ini; secret values are never returned (only a `configured` flag).
 * WRITE validates each changed key against the allowlist schema, preserves
 * unknown ini entries (patch semantics + backup + atomic), and for runtime-safe
 * keys additionally applies a live `changeoption` + `reloadoptions`.
 *
 * Configuration files are a Project Zomboid concern, not a runtime concern.
 * Whether a write is durable across a restart depends on the runtime: the
 * response carries `durableServerSettings` from runtime capabilities (false for
 * AMP, which regenerates the ini on restart; true for standalone).
 */

const MASK = '••••••••';

export interface SettingField {
  key: string;
  label: string;
  type: SettingDef['type'];
  value: unknown;
  desc?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Enum choices as display labels; the ini stores the matching number. */
  options?: string[];
  /** Operator-facing caution for destructive or self-locking changes. */
  warning?: string;
  restart?: boolean;
  secret?: boolean;
  configured?: boolean;
}
export interface SettingGroup {
  id: string;
  title: string;
  fields: SettingField[];
}

export async function getSettings(): Promise<SettingGroup[]> {
  const { values } = await readServerIni();
  const groups = new Map<string, SettingGroup>();
  for (const def of SETTINGS) {
    if (!groups.has(def.group.id)) groups.set(def.group.id, { id: def.group.id, title: def.group.title, fields: [] });
    const raw = values[def.iniKey];
    const field: SettingField = {
      key: def.key,
      label: def.label,
      type: def.type,
      value: def.secret ? '' : def.fromIni(raw),
      desc: def.desc,
      min: def.min,
      max: def.max,
      step: def.step,
      options: def.options,
      warning: def.warning,
      restart: def.restart,
      secret: def.secret,
    };
    if (def.secret) field.configured = Boolean(raw && raw.length > 0);
    groups.get(def.group.id)!.fields.push(field);
  }
  return [...groups.values()];
}

interface IncomingField {
  key: string;
  value: unknown;
}

/** Normalize the incoming payload (frontend sends the full groups array). */
function flatten(payload: unknown): IncomingField[] {
  const out: IncomingField[] = [];
  if (Array.isArray(payload)) {
    for (const group of payload) {
      for (const f of (group as SettingGroup)?.fields ?? []) {
        if (f && typeof f.key === 'string') out.push({ key: f.key, value: f.value });
      }
    }
  } else if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) out.push({ key, value });
  }
  return out;
}

function isUnchangedSecret(value: unknown): boolean {
  if (typeof value !== 'string') return value == null;
  const v = value.trim();
  return v === '' || /^[•*]+$/.test(v) || v === MASK;
}

export interface SaveResult {
  groups: SettingGroup[];
  saved: boolean;
  restartRequired: boolean;
  applied: string[];
  /** True when the runtime will not regenerate the ini (writes survive restart). */
  durableServerSettings: boolean;
}

export async function saveSettings(payload: unknown): Promise<SaveResult> {
  const incoming = flatten(payload);
  const patch: Record<string, string> = {};
  const liveApply: Array<{ iniKey: string; value: string }> = [];
  let restartRequired = false;

  for (const { key, value } of incoming) {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) continue; // ignore unknown keys entirely
    if (def.secret && isUnchangedSecret(value)) continue; // never write the mask
    const iniValue = def.toIni(value); // validates & throws on invalid
    patch[def.iniKey] = iniValue;
    if (def.restart) restartRequired = true;
    if (def.live) liveApply.push({ iniKey: def.iniKey, value: iniValue });
  }

  if (Object.keys(patch).length > 0) {
    await writeServerIni(patch);
    // Best-effort live application for runtime-safe options.
    for (const { iniKey, value } of liveApply) {
      try {
        await rcon.exec(rconCommands.changeOption(iniKey, value));
      } catch (e) {
        logger.debug({ err: (e as Error).message, iniKey }, 'live changeoption skipped');
      }
    }
    if (liveApply.length > 0) {
      try {
        await rcon.exec(rconCommands.reloadOptions());
      } catch {
        /* server offline; will apply on next start */
      }
    }
  }

  return {
    groups: await getSettings(),
    saved: true,
    restartRequired,
    applied: Object.keys(patch),
    durableServerSettings: runtime.capabilities().durableServerSettings,
  };
}
