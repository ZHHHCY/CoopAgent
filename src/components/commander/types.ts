export type CommanderSummary = {
  id: string;
  commanderObjectId: string;
  userReference: string;
  nameZhCN: string | null;
  nameEnUS: string | null;
  aliases: string[];
  portraitAsset: string;
  portraitCascPath: string;
  portraitDataUrl: string;
};

export type CommanderListResult = {
  database: {
    schemaVersion: number;
    sc2Build: string;
    sc2Version: string;
    source: string;
  };
  operation: "commander.list";
  total: number;
  items: CommanderSummary[];
  truncated: boolean;
};

export type CommanderLevelPerk = {
  level: number;
  id: string;
  nameZhCN: string | null;
  nameEnUS: string | null;
  tooltipZhCN: string | null;
  tooltipEnUS: string | null;
  iconAsset: string;
  iconCascPath: string;
  iconDataUrl: string;
  relatedEffects: CommanderUnitDetailItem[];
  affectedUnits: {
    unitId: string;
    nameZhCN: string | null;
    nameEnUS: string | null;
  }[];
};

export type CommanderPrestige = {
  index: number;
  id: string;
  nameZhCN: string | null;
  nameEnUS: string | null;
  tooltipZhCN: string | null;
  tooltipEnUS: string | null;
};

export type CommanderMastery = {
  category: number;
  id: string;
  nameZhCN: string | null;
  nameEnUS: string | null;
  pointIncrement: number | null;
  valueFormatZhCN: string | null;
  valueFormatEnUS: string | null;
};

export type CommanderRosterUnit = {
  techId: string;
  unitId: string;
  nameZhCN: string | null;
  nameEnUS: string | null;
  unlockedAtLevel: number | null;
  iconAsset: string;
  iconCascPath: string;
  iconDataUrl: string;
  stats: {
    unitId: string;
    lifeMax: number | null;
    shieldMax: number | null;
    lifeArmor: number | null;
    mineralCost: number | null;
    vespeneCost: number | null;
    supplyCost: number | null;
    movementSpeed: number | null;
    sight: number | null;
    cargoSize: number | null;
    attributes: string[];
    buildTime: number | null;
  };
  details?: {
    weapons: CommanderUnitDetailItem[];
    skills: CommanderUnitDetailItem[];
    commanderUpgrades: CommanderUnitDetailItem[];
  } | null;
};

export type CommanderUnitDetailItem = {
  ids: string[];
  nameZhCN: string;
  descriptionZhCN: string;
  level?: number;
  facts?: {
    label: string;
    value: string;
  }[];
};

export type CommanderPanelAbility = {
  id: string;
  abilityId: string;
  commandIndex: string | null;
  row: number;
  column: number;
  nameZhCN: string | null;
  nameEnUS: string | null;
  tooltipZhCN: string | null;
  tooltipEnUS: string | null;
  iconAsset: string;
  iconCascPath: string;
  iconDataUrl: string;
  stats: {
    cooldown: number | null;
    resources: {
      key: string;
      kind: string;
      id: string;
      amount: number;
    }[];
  };
};

export type CommanderDetailsResult = {
  operation: "commander.get";
  currentProject?: {
    kind: "current-edit-state";
    commanderId: string | null;
    runtimeValuesEvaluated: false;
  };
  commander: {
    id: string;
    commanderObjectId: string;
    nameZhCN: string | null;
    nameEnUS: string | null;
    aliases: string[];
  };
  roster: {
    units: CommanderRosterUnit[];
    buildings: CommanderRosterUnit[];
  };
  levelPerks: CommanderLevelPerk[];
  prestiges: CommanderPrestige[];
  masteries: CommanderMastery[];
  panel: {
    abilities: CommanderPanelAbility[];
    summonedUnits: (CommanderRosterUnit & {
      summonedByAbilityIds: string[];
    })[];
  };
};

export type AppliedChangeTarget = {
  kind: "commander" | "unit" | "ability" | "upgrade" | "levelPerk" | "prestige" | "mastery";
  id: string;
  label: string;
  commanderId: string | null;
  level?: number;
  index?: number;
  category?: number;
};

export type AppliedChangeSummary = {
  id: string;
  text: string;
  kind: string;
  before: unknown;
  after: unknown;
  field: string | null;
  opIds: string[];
  targets: AppliedChangeTarget[];
  status: string;
  verified: boolean;
  plan: {
    id: string;
    title: string;
    path: string;
    receiptPath: string;
    appliedAt: string;
    sha256: string;
  };
};

export type AppliedChangeSummaryListResult = {
  operation: "change_summary.list";
  total: number;
  items: AppliedChangeSummary[];
};

export type CommanderInspectionSelection =
  | { kind: "unit"; unit: CommanderRosterUnit }
  | { kind: "ability"; ability: CommanderPanelAbility }
  | { kind: "levelPerk"; perk: CommanderLevelPerk }
  | null;
