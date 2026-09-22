import { ErrorNotice } from "../common/ErrorNotice";
import { useEffect, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import {
  type ChangeIndicatorSnapshot,
  getCommanderChangeIndicator,
  hasCommanderChanges,
} from "../../changeIndicators";
import { ChangeIndicator } from "./ChangeIndicator";
import { commanderDisplayName, commanderFaction } from "./formatters";
import type { CommanderSummary } from "./types";
import "./CommanderPicker.css";

type Props = {
  agentReady: boolean;
  changeIndicators: ChangeIndicatorSnapshot;
  commanders: CommanderSummary[];
  error: string;
  loading: boolean;
  selectedCommander: CommanderSummary | null;
  selectedCommanderId: string | null;
  onSelect: (commanderId: string) => void;
};

export function CommanderPicker({
  agentReady,
  changeIndicators,
  commanders,
  error,
  loading,
  onSelect,
  selectedCommander,
  selectedCommanderId,
}: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!agentReady) setOpen(false);
  }, [agentReady]);

  const selectedChanges = selectedCommander
    ? getCommanderChangeIndicator(changeIndicators, selectedCommander.id)
    : undefined;

  return (
    <div className={`commander-picker${open ? " is-open" : ""}`}>
      <button
        className="commander-trigger"
        type="button"
        aria-expanded={open}
        aria-controls="commander-options"
        aria-label={selectedCommander
          ? `当前指挥官：${commanderDisplayName(selectedCommander)}`
          : "选择指挥官"}
        disabled={!agentReady}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={`commander-portrait${selectedCommander ? ` ${commanderFaction(selectedCommander.id)}` : ""}`}
          aria-hidden="true"
        >
          {selectedCommander
            ? <img alt="" src={selectedCommander.portraitDataUrl} />
            : <Plus size={24} />}
        </span>
        {hasCommanderChanges(selectedChanges) && selectedCommander ? (
          <ChangeIndicator label={`${commanderDisplayName(selectedCommander)} 有已应用改动`} />
        ) : null}
        <ChevronRight className="commander-trigger-chevron" size={15} aria-hidden="true" />
      </button>

      <section className="commander-drawer" id="commander-options" aria-label="指挥官列表">
        <div className="commander-drawer-header">
          <div><span>指挥官数据库</span><strong>选择指挥官</strong></div>
          <small>{loading ? "正在读取…" : `${commanders.length} 位指挥官`}</small>
        </div>
        {error ? (
          <ErrorNotice error={error} title="数据库内容暂时无法读取" hint="请在左侧环境设置中重新检查数据库，再选择指挥官。" />
        ) : (
          <div className="commander-options">
            {commanders.map((commander) => {
              const displayName = commanderDisplayName(commander);
              const changes = getCommanderChangeIndicator(changeIndicators, commander.id);
              return (
                <button
                  className={`commander-option ${commanderFaction(commander.id)}${commander.id === selectedCommanderId ? " selected" : ""}`}
                  key={commander.id}
                  type="button"
                  aria-pressed={commander.id === selectedCommanderId}
                  title={`${displayName} · ${commander.id}`}
                  onClick={() => {
                    onSelect(commander.id);
                    setOpen(false);
                  }}
                >
                  <span className="commander-option-portrait" aria-hidden="true">
                    <img alt="" src={commander.portraitDataUrl} />
                  </span>
                  {hasCommanderChanges(changes) ? (
                    <ChangeIndicator label={`${displayName} 有已应用改动`} />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
