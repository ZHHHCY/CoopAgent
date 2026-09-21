import type { AppliedChangeSummary } from "./components/commander/types";

export type CommanderChangeIndicator = {
  commanderId: string;
  changed?: boolean;
  levelPerkIds?: readonly string[];
  masteryCategories?: readonly number[];
  masteryIds?: readonly string[];
  prestigeIndexes?: readonly number[];
  prestigeIds?: readonly string[];
  unitIds?: readonly string[];
  abilityIds?: readonly string[];
};

export type ChangeIndicatorSnapshot = {
  commanders: readonly CommanderChangeIndicator[];
};

export function getCommanderChangeIndicator(
  snapshot: ChangeIndicatorSnapshot,
  commanderId: string,
) {
  return snapshot.commanders.find((entry) => entry.commanderId === commanderId);
}

export function hasCommanderChanges(entry: CommanderChangeIndicator | undefined) {
  if (!entry) return false;

  return (
    entry.changed === true ||
    (entry.levelPerkIds?.length ?? 0) > 0 ||
    (entry.masteryCategories?.length ?? 0) > 0 ||
    (entry.masteryIds?.length ?? 0) > 0 ||
    (entry.prestigeIndexes?.length ?? 0) > 0 ||
    (entry.prestigeIds?.length ?? 0) > 0 ||
    (entry.unitIds?.length ?? 0) > 0 ||
    (entry.abilityIds?.length ?? 0) > 0
  );
}

export function buildChangeIndicatorSnapshot(
  changes: readonly AppliedChangeSummary[],
): ChangeIndicatorSnapshot {
  const commanders = new Map<string, {
    levelPerkIds: Set<string>;
    masteryCategories: Set<number>;
    masteryIds: Set<string>;
    prestigeIndexes: Set<number>;
    prestigeIds: Set<string>;
    unitIds: Set<string>;
    abilityIds: Set<string>;
  }>();
  const ensure = (commanderId: string) => {
    let entry = commanders.get(commanderId);
    if (!entry) {
      entry = {
        levelPerkIds: new Set(),
        masteryCategories: new Set(),
        masteryIds: new Set(),
        prestigeIndexes: new Set(),
        prestigeIds: new Set(),
        unitIds: new Set(),
        abilityIds: new Set(),
      };
      commanders.set(commanderId, entry);
    }
    return entry;
  };
  for (const change of changes) {
    for (const target of change.targets) {
      const commanderId = target.commanderId
        ?? (target.kind === "commander" ? target.id : null);
      if (!commanderId) continue;
      const entry = ensure(commanderId);
      if (target.kind === "levelPerk") entry.levelPerkIds.add(target.id);
      if (target.kind === "mastery") {
        entry.masteryIds.add(target.id);
        if (target.category) entry.masteryCategories.add(target.category);
      }
      if (target.kind === "prestige") {
        entry.prestigeIds.add(target.id);
        if (target.index !== undefined) entry.prestigeIndexes.add(target.index);
      }
      if (target.kind === "unit") entry.unitIds.add(target.id);
      if (target.kind === "ability") entry.abilityIds.add(target.id);
    }
  }
  return {
    commanders: [...commanders.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([commanderId, entry]) => ({
        commanderId,
        changed: true,
        levelPerkIds: [...entry.levelPerkIds],
        masteryCategories: [...entry.masteryCategories],
        masteryIds: [...entry.masteryIds],
        prestigeIndexes: [...entry.prestigeIndexes],
        prestigeIds: [...entry.prestigeIds],
        unitIds: [...entry.unitIds],
        abilityIds: [...entry.abilityIds],
      })),
  };
}
