import type { RefObject } from "react";
import { sc2TooltipToText } from "./formatters";
import type { CommanderPanelAbility, CommanderRosterUnit } from "./types";

type CardPosition = { left: number; top: number } | null;

export function CommanderUnitCard({
  cardRef,
  position,
  unit,
}: {
  cardRef: RefObject<HTMLElement | null>;
  position: CardPosition;
  unit: CommanderRosterUnit;
}) {
  const name =
    unit.nameZhCN?.split(" /// ")[0]?.trim() ||
    unit.nameEnUS ||
    unit.stats.unitId ||
    unit.unitId;
  const formatValue = (value: number | null) =>
    value === null ? "—" : String(Number(value.toFixed(2)));
  const cost = unit.stats.mineralCost === null && unit.stats.vespeneCost === null
    ? "—"
    : `${formatValue(unit.stats.mineralCost ?? 0)} 矿 / ${formatValue(unit.stats.vespeneCost ?? 0)} 气`;

  return (
    <article
      className={`commander-unit-card${position ? " is-positioned" : ""}`}
      ref={cardRef}
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      <header>
        <strong>{name}</strong>
        <code>{unit.stats.unitId || unit.unitId}</code>
      </header>
      <dl>
        <div>
          <dt>{unit.stats.shieldMax === null ? "生命值" : "生命值 / 护盾"}</dt>
          <dd>
            {formatValue(unit.stats.lifeMax)}
            {unit.stats.shieldMax === null ? "" : ` / ${formatValue(unit.stats.shieldMax)}`}
          </dd>
        </div>
        <div>
          <dt>费用</dt>
          <dd>{cost}</dd>
        </div>
        <div>
          <dt>建造时间</dt>
          <dd>{unit.stats.buildTime === null ? "—" : `${formatValue(unit.stats.buildTime)} 秒`}</dd>
        </div>
      </dl>
    </article>
  );
}

export function CommanderPanelAbilityCard({
  ability,
  cardRef,
  position,
}: {
  ability: CommanderPanelAbility;
  cardRef: RefObject<HTMLElement | null>;
  position: CardPosition;
}) {
  const name =
    ability.nameZhCN?.split(" /// ")[0]?.trim() ||
    ability.nameEnUS ||
    ability.id;
  const abilityId = ability.commandIndex
    ? `${ability.abilityId},${ability.commandIndex}`
    : ability.abilityId;
  const effect = sc2TooltipToText(ability.tooltipZhCN || ability.tooltipEnUS)
    || "暂无效果说明";
  const formatNumber = (value: number) => String(Number(value.toFixed(2)));
  const resourceNames: Record<string, string> = {
    custom: "特殊资源",
    energy: "能量",
    life: "生命",
    minerals: "矿物",
    shields: "护盾",
    terrazine: "地嗪",
    vespene: "瓦斯",
  };
  const resources = ability.stats.resources
    .map((resource) => `${formatNumber(resource.amount)} ${resourceNames[resource.id.toLowerCase()] ?? resource.id}`)
    .join(" / ");

  return (
    <article
      className={`commander-ability-card${position ? " is-positioned" : ""}`}
      ref={cardRef}
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      <header>
        <strong>{name}</strong>
        <code>{abilityId}</code>
      </header>
      <section>
        <span>效果</span>
        <p>{effect}</p>
      </section>
      <dl>
        <div>
          <dt>冷却时间</dt>
          <dd>
            {ability.stats.cooldown === null
              ? "—"
              : `${formatNumber(ability.stats.cooldown)} 秒`}
          </dd>
        </div>
        {resources ? (
          <div>
            <dt>资源消耗</dt>
            <dd>{resources}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
