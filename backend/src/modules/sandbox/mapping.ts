import { err } from '../../shared/errors';
import type { LuaScalar } from '../../integrations/zomboid-files/sandbox';

/**
 * Sandbox enum mapping layer. Project Zomboid stores most sandbox options as
 * numeric enums; the frontend shows human labels. This module maps
 *   raw PZ numeric value  <->  frontend label
 * using enum legends read directly from THIS server's SandboxVars.lua comments
 * (Build 42), NOT the (outdated) mock. Only an allowlisted, verified subset is
 * exposed; any sandbox key not listed here is preserved untouched on save.
 *
 * For 1-based contiguous enums the array index+1 is the stored value, e.g.
 * SPEED[0]="Sprinters" is stored as 1.
 */

type EnumList = readonly string[];

const POPULATION: EnumList = ['Insane', 'Very High', 'High', 'Normal', 'Low', 'None'];
const DISTRIBUTION: EnumList = ['Urban Focused', 'Uniform'];
const RESPAWN: EnumList = ['High', 'Normal', 'Low', 'None'];
const FOOD_ROT: EnumList = ['Very Fast', 'Fast', 'Normal', 'Slow', 'Very Slow'];
const FREQ6: EnumList = ['Never', 'Extremely Rare', 'Rare', 'Sometimes', 'Often', 'Very Often'];
const SPEED: EnumList = ['Sprinters', 'Fast Shamblers', 'Shamblers', 'Random'];
const STRENGTH: EnumList = ['Superhuman', 'Normal', 'Weak', 'Random'];
const TOUGHNESS: EnumList = ['Tough', 'Normal', 'Fragile', 'Random'];
const COGNITION: EnumList = ['Navigate and Use Doors', 'Navigate', 'Basic Navigation', 'Random'];
const MEMORY: EnumList = ['Long', 'Normal', 'Short', 'None', 'Random', 'Random between Normal and None'];
const SIGHT: EnumList = ['Eagle', 'Normal', 'Poor', 'Random', 'Random between Normal and Poor'];
const HEARING: EnumList = ['Pinpoint', 'Normal', 'Poor', 'Random', 'Random between Normal and Poor'];
const TRANSMISSION: EnumList = ['Blood and Saliva', 'Saliva Only', "Everyone's Infected", 'None'];
const TEMPERATURE: EnumList = ['Very Cold', 'Cold', 'Normal', 'Hot', 'Very Hot'];
const RAIN: EnumList = ['Very Dry', 'Dry', 'Normal', 'Rainy', 'Very Rainy'];
const DAY_LENGTH: EnumList = [
  '15 Minutes', '30 Minutes', '1 Hour', '1 Hour, 30 Minutes', '2 Hours', '3 Hours', '4 Hours',
  '5 Hours', '6 Hours', '7 Hours', '8 Hours', '9 Hours', '10 Hours', '11 Hours', '12 Hours',
  '13 Hours', '14 Hours', '15 Hours', '16 Hours', '17 Hours', '18 Hours', '19 Hours', '20 Hours',
  '21 Hours', '22 Hours', '23 Hours', 'Real-time',
];
const MONTH: EnumList = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];
const START_TIME: EnumList = ['7 AM', '9 AM', '12 PM', '2 PM', '5 PM', '9 PM', '12 AM', '2 AM', '5 AM'];

export interface SandboxFieldDef {
  path: string; // SandboxVars path (dotted)
  label: string;
  category: string;
  section: { id: string; title: string };
  desc?: string;
  kind: 'enum' | 'number' | 'toggle';
  options?: EnumList; // for enum
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

const enumField = (
  path: string,
  label: string,
  category: string,
  section: { id: string; title: string },
  options: EnumList,
  desc?: string,
): SandboxFieldDef => ({ path, label, category, section, options, kind: 'enum', desc });

const S = {
  difficulty: { id: 'difficulty', title: 'Difficulty' },
  clock: { id: 'clock', title: 'Clock' },
  decay: { id: 'decay', title: 'Decay & Erosion' },
  alarms: { id: 'alarms', title: 'Alarms & Locks' },
  behaviour: { id: 'behaviour', title: 'Behaviour' },
  senses: { id: 'senses', title: 'Senses' },
  nature: { id: 'nature', title: 'Nature' },
};

/**
 * Curated, VERIFIED sandbox fields. Values, paths, and enum legends were read
 * from the live servertest_SandboxVars.lua. Fields the mock displayed that do
 * not exist under these names on Build 42 (e.g. XpMultiplier, FoodLoot) are
 * intentionally omitted rather than fabricated.
 */
export const SANDBOX_FIELDS: SandboxFieldDef[] = [
  enumField('Zombies', 'Zombie Population', 'General', S.difficulty, POPULATION, 'Overall amount of zombies.'),
  enumField('Distribution', 'Zombie Distribution', 'General', S.difficulty, DISTRIBUTION),
  enumField('ZombieRespawn', 'Zombie Respawn', 'General', S.difficulty, RESPAWN, 'How frequently new zombies are added.'),

  enumField('DayLength', 'Day Length', 'Time', S.clock, DAY_LENGTH),
  enumField('StartMonth', 'Start Month', 'Time', S.clock, MONTH),
  enumField('StartTime', 'Start Time', 'Time', S.clock, START_TIME),
  { path: 'StartYear', label: 'Start Year', category: 'Time', section: S.clock, kind: 'number', min: 1, max: 300 },

  enumField('FoodRotSpeed', 'Food Spoilage Speed', 'World', S.decay, FOOD_ROT),
  { path: 'WaterShutModifier', label: 'Water Shutoff', category: 'World', section: S.decay, kind: 'number', min: -1, max: 2147483647 },
  { path: 'ElecShutModifier', label: 'Electricity Shutoff', category: 'World', section: S.decay, kind: 'number', min: -1, max: 2147483647 },
  enumField('Alarm', 'House Alarm Frequency', 'World', S.alarms, FREQ6),
  enumField('LockedHouses', 'Locked Houses', 'World', S.alarms, FREQ6),

  // Build 42 nests these under the ZombieLore table (verified against the live
  // SandboxVars.lua — they are NOT top-level as older builds/the mock assumed).
  enumField('ZombieLore.Speed', 'Speed', 'Zombies', S.behaviour, SPEED),
  enumField('ZombieLore.Strength', 'Strength', 'Zombies', S.behaviour, STRENGTH),
  enumField('ZombieLore.Toughness', 'Toughness', 'Zombies', S.behaviour, TOUGHNESS),
  enumField('ZombieLore.Cognition', 'Cognition', 'Zombies', S.behaviour, COGNITION),
  enumField('ZombieLore.Memory', 'Memory', 'Zombies', S.behaviour, MEMORY),
  enumField('ZombieLore.Sight', 'Sight', 'Zombies', S.senses, SIGHT),
  enumField('ZombieLore.Hearing', 'Hearing', 'Zombies', S.senses, HEARING),
  enumField('ZombieLore.Transmission', 'Infection Transmission', 'Zombies', S.senses, TRANSMISSION),

  enumField('Temperature', 'Temperature', 'Nature', S.nature, TEMPERATURE),
  enumField('Rain', 'Rain Frequency', 'Nature', S.nature, RAIN),
];

export const SANDBOX_BY_PATH = new Map(SANDBOX_FIELDS.map((f) => [f.path, f]));

/** raw numeric enum value -> label (1-based). */
export function enumToLabel(options: EnumList, value: LuaScalar): string {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return options[n - 1] ?? String(value);
}

/** label -> raw numeric enum value (1-based). Throws on unknown label. */
export function labelToEnum(options: EnumList, label: string): number {
  const i = options.indexOf(label);
  if (i === -1) throw err.invalid(`Invalid value "${label}".`, { allowed: options });
  return i + 1;
}
