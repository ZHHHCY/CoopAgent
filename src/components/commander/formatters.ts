import type { CommanderMastery, CommanderSummary } from "./types";

export function commanderDisplayName(commander: CommanderSummary) {
  return (
    commander.nameZhCN?.split(" /// ")[0]?.trim() ||
    commander.nameEnUS ||
    commander.commanderObjectId
  );
}

export function commanderFaction(commanderId: string) {
  if (commanderId.startsWith("Protoss")) return "protoss";
  if (commanderId.startsWith("Zerg")) return "zerg";
  return "terran";
}

export function sc2TooltipToText(value: string | null) {
  if (!value) return "";
  return value
    .replace(/<n\s*\/>/gi, "\n")
    .replace(/<br\s*\/>/gi, "\n")
    .replace(/<d\b[^>]*\/?\s*>/gi, "未知数值")
    .replace(/<\/d\s*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function masteryEffectSummary(mastery: CommanderMastery) {
  if (typeof mastery.pointIncrement !== "number" || !Number.isFinite(mastery.pointIncrement)) {
    return "暂无数值说明";
  }
  const format = mastery.valueFormatZhCN || mastery.valueFormatEnUS || "~A~";
  const formatValue = (value: number) =>
    format.replace("~A~", String(Number(value.toFixed(4))));
  return `每点 ${formatValue(mastery.pointIncrement)} · 30 点 ${formatValue(mastery.pointIncrement * 30)}`;
}
