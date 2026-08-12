/**
 * Category / section placement and display labels for sandbox options.
 *
 * The option METADATA (descriptions, bounds, enum legends, advisories) is
 * generated from Project Zomboid's own SandboxVars.lua comments — see
 * scripts/generate-sandbox-schema.ts. PZ does not record its UI grouping in
 * that file, so the grouping below is maintained here, modelled on the in-game
 * Sandbox Options screens.
 *
 * Any path that matches no rule falls through to "Advanced" — the schema never
 * silently drops a field.
 */

export interface Placement {
  category: string;
  section: string;
}

/** Nested tables map wholesale onto their own categories. */
const PREFIX_RULES: Array<[string, Placement]> = [
  ['ZombieLore.', { category: 'Zombie Lore', section: 'Zombie Lore' }],
  ['ZombieConfig.', { category: 'Advanced Zombies', section: 'Population & Respawn' }],
  ['MultiplierConfig.', { category: 'XP Multipliers', section: 'Skill Multipliers' }],
  ['Map.', { category: 'Map', section: 'Map & Minimap' }],
  ['Basement.', { category: 'Map', section: 'World Generation' }],
];

/** Explicit top-level placement: section title -> the keys it contains. */
const SECTIONS: Array<{ category: string; section: string; keys: string[] }> = [
  {
    category: 'General',
    section: 'Zombie Population',
    keys: ['Zombies', 'Distribution', 'ZombieVoronoiNoise', 'ZombieRespawn', 'ZombieMigrate', 'ZombiePopLootEffect'],
  },
  {
    category: 'Time & World',
    section: 'Clock & Calendar',
    keys: ['DayLength', 'StartYear', 'StartMonth', 'StartDay', 'StartTime', 'TimeSinceApo'],
  },
  {
    category: 'Time & World',
    section: 'Cycles & Darkness',
    keys: ['DayNightCycle', 'ClimateCycle', 'FogCycle', 'NightLength', 'NightDarkness'],
  },
  {
    category: 'Time & World',
    section: 'Weather',
    keys: ['Temperature', 'Rain', 'MaxFogIntensity', 'MaxRainFxIntensity', 'EnableSnowOnGround'],
  },
  {
    category: 'Time & World',
    section: 'Power & Utilities',
    keys: [
      'WaterShut', 'ElecShut', 'WaterShutModifier', 'ElecShutModifier',
      'GeneratorFuelConsumption', 'GeneratorSpawning', 'AllowExteriorGenerator',
      'GeneratorTileRange', 'GeneratorVerticalPowerRange', 'LightBulbLifespan',
    ],
  },
  {
    category: 'Time & World',
    section: 'Alarms & Locks',
    keys: ['Alarm', 'LockedHouses', 'AlarmDecay', 'AlarmDecayModifier'],
  },
  {
    category: 'Time & World',
    section: 'Fire',
    keys: ['FireSpread', 'MaximumFireFuelHours'],
  },
  {
    category: 'Time & World',
    section: 'Events & World Stories',
    keys: [
      'EndRegen', 'Helicopter', 'MetaEvent', 'SleepingEvent', 'AnnotatedMapChance',
      'SurvivorHouseChance', 'VehicleStoryChance', 'ZoneStoryChance', 'ClayLakeChance', 'ClayRiverChance',
    ],
  },
  {
    category: 'Loot',
    section: 'Loot Categories',
    keys: [
      'FoodLootNew', 'LiteratureLootNew', 'SkillBookLoot', 'RecipeResourceLoot', 'MedicalLootNew',
      'SurvivalGearsLootNew', 'CannedFoodLootNew', 'WeaponLootNew', 'RangedWeaponLootNew', 'AmmoLootNew',
      'MechanicsLootNew', 'OtherLootNew', 'ClothingLootNew', 'ContainerLootNew', 'KeyLootNew',
      'MediaLootNew', 'MementoLootNew', 'CookwareLootNew', 'MaterialLootNew', 'FarmingLootNew', 'ToolLootNew',
    ],
  },
  {
    category: 'Loot',
    section: 'Rarity Factors',
    keys: ['InsaneLootFactor', 'ExtremeLootFactor', 'RareLootFactor', 'NormalLootFactor', 'CommonLootFactor', 'AbundantLootFactor'],
  },
  {
    category: 'Loot',
    section: 'Respawn & Removal',
    keys: [
      'SeenHoursPreventLootRespawn', 'HoursForLootRespawn', 'MaxItemsForLootRespawn',
      'ConstructionPreventsLootRespawn', 'WorldItemRemovalList', 'HoursForWorldItemRemoval',
      'ItemRemovalListBlacklistToggle', 'LootItemRemovalList', 'RemoveStoryLoot', 'RemoveZombieLoot',
    ],
  },
  {
    category: 'Loot',
    section: 'Diminished & Looted Buildings',
    keys: [
      'MaximumLooted', 'DaysUntilMaximumLooted', 'RuralLooted',
      'MaximumDiminishedLoot', 'DaysUntilMaximumDiminishedLoot', 'MaximumLootedBuildingRooms',
    ],
  },
  { category: 'Loot', section: 'Advanced Loot', keys: ['RollsMultiplier'] },
  {
    category: 'Food & Items',
    section: 'Food & Spoilage',
    keys: ['FoodRotSpeed', 'FridgeFactor', 'DaysForRottenFoodRemoval', 'Nutrition', 'EnablePoisoning', 'MaggotSpawn', 'EnableTaintedWaterText'],
  },
  {
    category: 'Food & Items',
    section: 'Clothing & Condition',
    keys: ['ClothingDegradation', 'AllClothesUnlocked', 'NoBlackClothes'],
  },
  {
    category: 'Nature & Farming',
    section: 'Farming',
    keys: [
      'Farming', 'CompostTime', 'PlantResilience', 'PlantAbundance', 'KillInsideCrops',
      'PlantGrowingSeasons', 'PlaceDirtAboveground', 'FarmingSpeedNew', 'FarmingAmountNew',
    ],
  },
  {
    category: 'Nature & Farming',
    section: 'Nature & Erosion',
    keys: ['NatureAbundance', 'ErosionSpeed', 'ErosionDays', 'FishAbundance'],
  },
  {
    category: 'Character',
    section: 'Character Creation',
    keys: ['CharacterFreePoints', 'ConstructionBonusPoints', 'StarterKit', 'NegativeTraitsPenalty'],
  },
  {
    category: 'Character',
    section: 'Health & Injury',
    keys: [
      'StatsDecrease', 'BoneFracture', 'InjurySeverity', 'RearVulnerability', 'MultiHitZombies',
      'MuscleStrainFactor', 'DiscomfortFactor', 'WoundInfectionFactor', 'EasyClimbing',
      'BloodLevel', 'AttackBlockMovements',
    ],
  },
  {
    category: 'Character',
    section: 'Learning & Reading',
    keys: ['MinutesPerPage', 'LevelForMediaXPCutoff', 'LevelForDismantleXPCutoff', 'LiteratureCooldown', 'MetaKnowledge', 'SeeNotLearntRecipe'],
  },
  {
    category: 'Character',
    section: 'Corpses & Blood',
    keys: ['HoursForCorpseRemoval', 'DecayingCorpseHealthImpact', 'ZombieHealthImpact', 'BloodSplatLifespanDays'],
  },
  {
    category: 'Vehicles',
    section: 'Spawning & Condition',
    keys: [
      'EnableVehicles', 'CarSpawnRate', 'VehicleEasyUse', 'LockedCar', 'CarGeneralCondition',
      'TrafficJam', 'RecentlySurvivorVehicles', 'ChanceHasGas',
    ],
  },
  {
    category: 'Vehicles',
    section: 'Fuel',
    keys: ['InitialGas', 'CarGasConsumption', 'FuelStationGasInfinite', 'FuelStationGasMin', 'FuelStationGasMax', 'FuelStationGasEmptyChance'],
  },
  {
    category: 'Vehicles',
    section: 'Damage & Noise',
    keys: [
      'CarDamageOnImpact', 'DamageToPlayerFromHitByACar', 'PlayerDamageFromCrash',
      'CarAlarm', 'SirenShutoffHours', 'SirenEffectsZombies', 'ZombieAttractionMultiplier',
    ],
  },
  {
    category: 'Animals',
    section: 'Livestock',
    keys: [
      'AnimalStatsModifier', 'AnimalMetaStatsModifier', 'AnimalPregnancyTime', 'AnimalAgeModifier',
      'AnimalMilkIncModifier', 'AnimalWoolIncModifier', 'AnimalRanchChance', 'AnimalGrassRegrowTime',
      'AnimalMatingSeason', 'AnimalEggHatch',
    ],
  },
  {
    category: 'Animals',
    section: 'Wildlife & Tracking',
    keys: [
      'AnimalMetaPredator', 'AnimalSoundAttractZombies', 'AnimalTrackChance', 'AnimalPathChance',
      'MaximumRatIndex', 'DaysUntilMaximumRatIndex',
    ],
  },
  {
    category: 'Firearms',
    section: 'Firearms',
    keys: [
      'FirearmUseDamageChance', 'FirearmNoiseMultiplier', 'FirearmJamMultiplier',
      'FirearmMoodleMultiplier', 'FirearmWeatherMultiplier', 'FirearmHeadGearEffect',
    ],
  },
];

const PLACEMENT = new Map<string, Placement>();
for (const { category, section, keys } of SECTIONS) {
  for (const k of keys) PLACEMENT.set(k, { category, section });
}

/** Where a sandbox path belongs in the UI. Unknown paths land in "Advanced". */
export function categoryFor(path: string): Placement {
  for (const [prefix, placement] of PREFIX_RULES) {
    if (path.startsWith(prefix)) return placement;
  }
  return PLACEMENT.get(path) ?? { category: 'Advanced', section: 'Other Options' };
}

/** Human labels that camelCase splitting alone would render awkwardly. */
const LABEL_OVERRIDES: Record<string, string> = {
  ZombiePopLootEffect: 'Zombie Population Loot Effect',
  TimeSinceApo: 'Time Since Apocalypse',
  ElecShut: 'Electricity Shutoff',
  ElecShutModifier: 'Electricity Shutoff (Days)',
  WaterShutModifier: 'Water Shutoff (Days)',
  AlarmDecayModifier: 'Alarm Decay (Days)',
  LevelForMediaXPCutoff: 'Media XP Cutoff Level',
  LevelForDismantleXPCutoff: 'Dismantle XP Cutoff Level',
  DamageToPlayerFromHitByACar: 'Damage to Player Hit by a Car',
  'MultiplierConfig.Lightfoot': 'Lightfooted',
  'MultiplierConfig.Blunt': 'Long Blunt',
  'MultiplierConfig.SmallBlunt': 'Short Blunt',
  'MultiplierConfig.LongBlade': 'Long Blade',
  'MultiplierConfig.SmallBlade': 'Short Blade',
  'MultiplierConfig.Woodwork': 'Carpentry',
  'MultiplierConfig.MetalWelding': 'Metalworking',
  'MultiplierConfig.PlantScavenging': 'Foraging',
  'MultiplierConfig.Doctor': 'First Aid',
  'MultiplierConfig.GlobalToggle': 'Use Global Multiplier',
};

/** Display label for a path: override, else the key split on camelCase. */
export function labelFor(path: string): string {
  if (LABEL_OVERRIDES[path]) return LABEL_OVERRIDES[path];
  const key = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bNew\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Category display order in the UI (unlisted categories follow, alphabetically). */
export const CATEGORY_ORDER = [
  'General',
  'Time & World',
  'Loot',
  'Food & Items',
  'Nature & Farming',
  'Character',
  'Vehicles',
  'Animals',
  'Firearms',
  'Map',
  'Zombie Lore',
  'Advanced Zombies',
  'XP Multipliers',
  'Advanced',
];
