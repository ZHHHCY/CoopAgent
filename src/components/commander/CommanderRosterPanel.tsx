import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CommanderPanelAbilityCard, CommanderUnitCard } from "./CommanderCards";
import { commanderDisplayName, commanderFaction } from "./formatters";
import type { CommanderWorkspaceSelection } from "./CommanderSelection";
import type {
  CommanderDetailsResult,
  CommanderInspectionSelection,
  CommanderPanelAbility,
  CommanderRosterUnit,
  CommanderSummary,
} from "./types";
import "./CommanderRosterPanel.css";

type Props = {
  commander: CommanderSummary;
  details: CommanderDetailsResult;
  selection: CommanderWorkspaceSelection;
  onSelect: (
    selection: CommanderWorkspaceSelection,
    inspection: CommanderInspectionSelection,
  ) => void;
};

type CardPosition = { left: number; top: number } | null;

export function CommanderRosterPanel({ commander, details, onSelect, selection }: Props) {
  const [unitCardPosition, setUnitCardPosition] = useState<CardPosition>(null);
  const [abilityCardPosition, setAbilityCardPosition] = useState<CardPosition>(null);
  const panelRef = useRef<HTMLElement>(null);
  const selectedUnitAnchorRef = useRef<HTMLButtonElement | null>(null);
  const unitCardRef = useRef<HTMLElement>(null);
  const selectedAbilityAnchorRef = useRef<HTMLButtonElement | null>(null);
  const abilityCardRef = useRef<HTMLElement>(null);

  const selectedUnitDetails = useMemo(() => {
    if (selection?.kind !== "unit") return null;
    const items = selection.section === "roster"
      ? [...details.roster.units, ...details.roster.buildings]
      : details.panel.summonedUnits;
    return items.find((unit) => `${unit.techId}-${unit.unitId}` === selection.key) ?? null;
  }, [details, selection]);

  const selectedAbilityDetails = useMemo(
    () => selection?.kind === "ability"
      ? details.panel.abilities.find((ability) =>
        `${ability.abilityId}-${ability.commandIndex ?? "default"}` === selection.key) ?? null
      : null,
    [details, selection],
  );

  useLayoutEffect(() => {
    if (!selectedUnitDetails) {
      setUnitCardPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const anchor = selectedUnitAnchorRef.current;
      const card = unitCardRef.current;
      if (!panel || !anchor || !card) return;
      const panelRect = panel.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const padding = 2;
      const desiredLeft = anchorRect.left - panelRect.left;
      const desiredTop = anchorRect.bottom - panelRect.top + 8;
      const maxLeft = Math.max(padding, panel.clientWidth - card.offsetWidth - padding);
      const maxTop = Math.max(padding, panel.clientHeight - card.offsetHeight - padding);
      setUnitCardPosition({
        left: panel.scrollLeft + Math.max(padding, Math.min(desiredLeft, maxLeft)),
        top: panel.scrollTop + Math.max(padding, Math.min(desiredTop, maxTop)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedUnitDetails]);

  useLayoutEffect(() => {
    if (!selectedAbilityDetails) {
      setAbilityCardPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const anchor = selectedAbilityAnchorRef.current;
      const card = abilityCardRef.current;
      if (!panel || !anchor || !card) return;
      const panelRect = panel.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const padding = 2;
      const desiredLeft = anchorRect.left - panelRect.left;
      const desiredTop = anchorRect.top - panelRect.top - card.offsetHeight - 8;
      const maxLeft = Math.max(padding, panel.clientWidth - card.offsetWidth - padding);
      const maxTop = Math.max(padding, panel.clientHeight - card.offsetHeight - padding);
      setAbilityCardPosition({
        left: panel.scrollLeft + Math.max(padding, Math.min(desiredLeft, maxLeft)),
        top: panel.scrollTop + Math.max(padding, Math.min(desiredTop, maxTop)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedAbilityDetails]);

  function selectUnit(
    unit: CommanderRosterUnit,
    section: "roster" | "panel",
    event: React.MouseEvent<HTMLButtonElement>,
  ) {
    const key = `${unit.techId}-${unit.unitId}`;
    const selected = selection?.kind === "unit"
      && selection.section === section
      && selection.key === key;
    selectedUnitAnchorRef.current = selected ? null : event.currentTarget;
    selectedAbilityAnchorRef.current = null;
    setUnitCardPosition(null);
    setAbilityCardPosition(null);
    onSelect(
      selected ? null : { kind: "unit", section, key },
      selected ? null : { kind: "unit", unit },
    );
  }

  function selectAbility(ability: CommanderPanelAbility, event: React.MouseEvent<HTMLButtonElement>) {
    const key = `${ability.abilityId}-${ability.commandIndex ?? "default"}`;
    const selected = selection?.kind === "ability" && selection.key === key;
    selectedAbilityAnchorRef.current = selected ? null : event.currentTarget;
    selectedUnitAnchorRef.current = null;
    setUnitCardPosition(null);
    setAbilityCardPosition(null);
    onSelect(
      selected ? null : { kind: "ability", key },
      selected ? null : { kind: "ability", ability },
    );
  }

  return (
    <section
      className={`commander-roster-panel ${commanderFaction(commander.id)}`}
      aria-label={`${commanderDisplayName(commander)} 的单位`}
      ref={panelRef}
    >
      {details.currentProject ? (
        <p className="commander-level-message">当前工程数值 · 未计算研究和战斗中的加成</p>
      ) : null}
      <RosterSection
        title="阵容"
        label="单位"
        units={[...details.roster.units, ...details.roster.buildings]}
        selected={selection?.kind === "unit" && selection.section === "roster" ? selection.key : null}
        onSelect={(unit, event) => selectUnit(unit, "roster", event)}
      />
      <div className="commander-roster-section">
        <header>
          <div><span>技能</span><strong>面板</strong></div>
          <small>{details.panel.abilities.length + details.panel.summonedUnits.length}</small>
        </header>
        <div className="commander-roster-list">
          {details.panel.abilities.map((ability) => {
            const key = `${ability.abilityId}-${ability.commandIndex ?? "default"}`;
            const name = ability.nameZhCN?.split(" /// ")[0]?.trim() || ability.nameEnUS || ability.id;
            const selected = selection?.kind === "ability" && selection.key === key;
            return (
              <button
                aria-label={name}
                aria-pressed={selected}
                className={`commander-roster-item${selected ? " selected" : ""}`}
                key={key}
                onClick={(event) => selectAbility(ability, event)}
                type="button"
              >
                <img alt="" draggable="false" src={ability.iconDataUrl} />
              </button>
            );
          })}
          {details.panel.summonedUnits.map((unit) => {
            const key = `${unit.techId}-${unit.unitId}`;
            const name = unit.nameZhCN?.split(" /// ")[0]?.trim() || unit.nameEnUS || unit.unitId;
            const selected = selection?.kind === "unit"
              && selection.section === "panel"
              && selection.key === key;
            return (
              <button
                aria-label={`召唤单位：${name}`}
                aria-pressed={selected}
                className={`commander-roster-item${selected ? " selected" : ""}`}
                key={`panel-summon-${unit.unitId}`}
                onClick={(event) => selectUnit(unit, "panel", event)}
                type="button"
              >
                <img alt="" draggable="false" src={unit.iconDataUrl} />
              </button>
            );
          })}
        </div>
      </div>
      {selectedUnitDetails ? (
        <CommanderUnitCard
          cardRef={unitCardRef}
          position={unitCardPosition}
          unit={selectedUnitDetails}
        />
      ) : null}
      {selectedAbilityDetails ? (
        <CommanderPanelAbilityCard
          ability={selectedAbilityDetails}
          cardRef={abilityCardRef}
          position={abilityCardPosition}
        />
      ) : null}
    </section>
  );
}

function RosterSection({
  label,
  onSelect,
  selected,
  title,
  units,
}: {
  label: string;
  onSelect: (unit: CommanderRosterUnit, event: React.MouseEvent<HTMLButtonElement>) => void;
  selected: string | null;
  title: string;
  units: CommanderRosterUnit[];
}) {
  return (
    <div className="commander-roster-section">
      <header><div><span>{label}</span><strong>{title}</strong></div><small>{units.length}</small></header>
      <div className="commander-roster-list">
        {units.map((unit) => {
          const key = `${unit.techId}-${unit.unitId}`;
          const name = unit.nameZhCN?.split(" /// ")[0]?.trim() || unit.nameEnUS || unit.unitId;
          return (
            <button
              aria-label={name}
              aria-pressed={selected === key}
              className={`commander-roster-item${selected === key ? " selected" : ""}`}
              key={key}
              onClick={(event) => onSelect(unit, event)}
              type="button"
            >
              <img alt="" draggable="false" src={unit.iconDataUrl} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
