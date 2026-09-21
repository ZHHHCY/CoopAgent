import type { CommanderChangeIndicator } from "../../changeIndicators";
import { ChangeIndicator } from "./ChangeIndicator";
import { commanderDisplayName, commanderFaction, masteryEffectSummary, sc2TooltipToText } from "./formatters";
import type { CommanderWorkspaceSelection } from "./CommanderSelection";
import type {
  CommanderDetailsResult,
  CommanderInspectionSelection,
  CommanderSummary,
} from "./types";
import "./CommanderProgression.css";

type Props = {
  changes?: CommanderChangeIndicator;
  commander: CommanderSummary;
  details: CommanderDetailsResult | null;
  error: string;
  loading: boolean;
  selection: CommanderWorkspaceSelection;
  onSelect: (
    selection: CommanderWorkspaceSelection,
    inspection: CommanderInspectionSelection,
  ) => void;
};

export function CommanderProgression({
  changes,
  commander,
  details,
  error,
  loading,
  onSelect,
  selection,
}: Props) {
  return (
    <>
      <section
        className={`commander-level-panel ${commanderFaction(commander.id)}`}
        aria-label={`${commanderDisplayName(commander)} 1 至 15 级升级`}
      >
        {loading ? (
          <p className="commander-level-message">正在读取升级数据…</p>
        ) : error ? (
          <p className="commander-level-message is-error" role="alert">{error}</p>
        ) : (
          <div className="commander-level-grid">
            {(details?.levelPerks ?? []).slice().sort((a, b) => a.level - b.level).map((perk) => {
              const perkName = perk.nameZhCN?.split(" /// ")[0]?.trim() || perk.nameEnUS || perk.id;
              const selected = selection?.kind === "levelPerk" && selection.id === perk.id;
              return (
                <button
                  className={`commander-level-item${selected ? " selected" : ""}`}
                  key={`${perk.level}-${perk.id}`}
                  type="button"
                  aria-label={`${perk.level} 级：${perkName}`}
                  aria-pressed={selected}
                  title={`${perk.level} 级 · ${perkName}`}
                  onClick={() => onSelect(
                    selected ? null : { kind: "levelPerk", id: perk.id },
                    selected ? null : { kind: "levelPerk", perk },
                  )}
                >
                  <img alt="" src={perk.iconDataUrl} />
                  <span>{perk.level}</span>
                  {changes?.levelPerkIds?.includes(perk.id) ? (
                    <ChangeIndicator label={`${perkName} 有已应用改动`} />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {details && !loading ? (
        <section className={`commander-mastery-panel ${commanderFaction(commander.id)}`}>
          <span className="commander-mastery-label">精通</span>
          <div className="commander-mastery-groups">
            {[1, 2, 3].map((category) => {
              const selected = selection?.kind === "mastery" && selection.category === category;
              const changed = changes?.masteryCategories?.includes(category)
                || details.masteries.some((mastery) =>
                  mastery.category === category && changes?.masteryIds?.includes(mastery.id));
              return (
                <button
                  className={selected ? "selected" : ""}
                  key={category}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(
                    selected ? null : { kind: "mastery", category },
                    null,
                  )}
                >
                  M{category}
                  {changed ? (
                    <ChangeIndicator label={`精通 M${category} 有已应用改动`} />
                  ) : null}
                </button>
              );
            })}
          </div>
          {selection?.kind === "mastery" ? (
            <div className="commander-mastery-drawer">
              {details.masteries
                .filter((mastery) => mastery.category === selection.category)
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((mastery) => (
                  <article className="commander-mastery-item" key={mastery.id}>
                    <strong>{mastery.nameZhCN?.split(" /// ")[0]?.trim() || mastery.nameEnUS || mastery.id}</strong>
                    <small>{masteryEffectSummary(mastery)}</small>
                  </article>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {details && !loading ? (
        <section className={`commander-prestige-panel ${commanderFaction(commander.id)}`}>
          <span className="commander-prestige-label">威望</span>
          <div className="commander-prestige-groups">
            {details.prestiges.slice().sort((a, b) => a.index - b.index).map((prestige) => {
              const selected = selection?.kind === "prestige" && selection.index === prestige.index;
              const changed = changes?.prestigeIndexes?.includes(prestige.index)
                || changes?.prestigeIds?.includes(prestige.id);
              return (
                <button
                  className={selected ? "selected" : ""}
                  key={prestige.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(
                    selected ? null : { kind: "prestige", index: prestige.index },
                    null,
                  )}
                >
                  P{prestige.index + 1}
                  {changed ? (
                    <ChangeIndicator label={`威望 P${prestige.index + 1} 有已应用改动`} />
                  ) : null}
                </button>
              );
            })}
          </div>
          {selection?.kind === "prestige" ? (
            <div className="commander-prestige-drawer">
              {details.prestiges
                .filter((prestige) => prestige.index === selection.index)
                .map((prestige) => (
                  <article className="commander-prestige-detail" key={prestige.id}>
                    <strong>{prestige.nameZhCN?.split(" /// ")[0]?.trim() || prestige.nameEnUS || prestige.id}</strong>
                    <p>{sc2TooltipToText(prestige.tooltipZhCN || prestige.tooltipEnUS) || "暂无效果说明"}</p>
                  </article>
                ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
