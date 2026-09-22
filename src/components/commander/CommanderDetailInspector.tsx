import { ErrorNotice } from "../common/ErrorNotice";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sc2TooltipToText } from "./formatters";
import type {
  AppliedChangeSummary,
  CommanderInspectionSelection,
  CommanderUnitDetailItem,
} from "./types";
import "./CommanderDetailInspector.css";

export function CommanderDetailInspector({
  selection,
}: {
  selection: CommanderInspectionSelection;
}) {
  if (selection?.kind === "levelPerk") {
    const { perk } = selection;
    const name =
      perk.nameZhCN?.split(" /// ")[0]?.trim() ||
      perk.nameEnUS ||
      perk.id;
    const effect = sc2TooltipToText(perk.tooltipZhCN || perk.tooltipEnUS)
      || "暂无效果说明";
    return (
      <div className="detail-inspector-content">
        <div className="detail-inspector-identity is-level-perk">
          <img alt="" draggable="false" src={perk.iconDataUrl} />
          <div>
            <span className="detail-inspector-level">指挥官等级 {perk.level}</span>
            <strong>{name}</strong>
            <CopyableInspectorId value={perk.id} />
          </div>
        </div>
        <section className="detail-inspector-section is-perk-effect">
          <header><strong>官方说明</strong></header>
          <p>{effect}</p>
        </section>
        {(perk.affectedUnits ?? []).length ? (
          <section className="detail-inspector-section is-perk-units">
            <header><strong>影响对象</strong></header>
            <div className="detail-inspector-tags">
              {(perk.affectedUnits ?? []).map((unit) => (
                <span key={unit.unitId}>
                  {unit.nameZhCN?.split(" /// ")[0]?.trim() || unit.nameEnUS || unit.unitId}
                </span>
              ))}
            </div>
          </section>
        ) : null}
        <InspectorDetailSection
          emptyText="数据库中没有记录额外的关联对象。"
          items={perk.relatedEffects ?? []}
          title="关联效果"
        />
      </div>
    );
  }

  if (selection?.kind === "unit") {
    const { unit } = selection;
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
    const attributeNames: Record<string, string> = {
      Light: "轻甲",
      Armored: "重甲",
      Biological: "生物",
      Mechanical: "机械",
      Psionic: "灵能",
      Massive: "巨型",
      Structure: "建筑",
      Heroic: "英雄",
    };
    const attributeOrder = [
      "Light",
      "Armored",
      "Biological",
      "Mechanical",
      "Psionic",
      "Massive",
      "Structure",
      "Heroic",
    ];
    const attributes = [...unit.stats.attributes]
      .sort((left, right) => {
        const leftIndex = attributeOrder.indexOf(left);
        const rightIndex = attributeOrder.indexOf(right);
        return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
          || left.localeCompare(right);
      })
      .map((attribute) => attributeNames[attribute] ?? attribute)
      .join("、");
    return (
      <div className="detail-inspector-content">
        <div className="detail-inspector-identity">
          <img alt="" draggable="false" src={unit.iconDataUrl} />
          <div>
            <strong>{name}</strong>
            <CopyableInspectorId value={unit.stats.unitId || unit.unitId} />
          </div>
        </div>
        <section className="detail-inspector-section is-basic">
          <header>
            <strong>基础属性</strong>
          </header>
          <dl className="detail-inspector-stats">
            <div><dt>费用</dt><dd>{cost}</dd></div>
            <div><dt>生命值</dt><dd>{formatValue(unit.stats.lifeMax)}</dd></div>
            {unit.stats.shieldMax !== null ? (
              <div><dt>护盾</dt><dd>{formatValue(unit.stats.shieldMax)}</dd></div>
            ) : null}
            <div><dt>初始护甲</dt><dd>{formatValue(unit.stats.lifeArmor)}</dd></div>
            {unit.stats.supplyCost !== null ? (
              <div><dt>人口</dt><dd>{formatValue(unit.stats.supplyCost)}</dd></div>
            ) : null}
            {unit.stats.movementSpeed !== null ? (
              <div><dt>移动速度</dt><dd>{formatValue(unit.stats.movementSpeed)}</dd></div>
            ) : null}
            {unit.stats.sight !== null ? (
              <div><dt>视野</dt><dd>{formatValue(unit.stats.sight)}</dd></div>
            ) : null}
            {attributes ? <div><dt>单位类型</dt><dd>{attributes}</dd></div> : null}
            {unit.stats.cargoSize !== null ? (
              <div><dt>运输舱占用</dt><dd>{formatValue(unit.stats.cargoSize)}</dd></div>
            ) : null}
            <div>
              <dt>建造时间</dt>
              <dd>{unit.stats.buildTime === null ? "—" : `${formatValue(unit.stats.buildTime)} 秒`}</dd>
            </div>
          </dl>
        </section>
        {unit.details ? (
          <>
            <InspectorDetailSection items={unit.details.weapons} title="武器" />
            <InspectorDetailSection items={unit.details.skills} title="技能" />
            <InspectorDetailSection
              items={unit.details.commanderUpgrades}
              title="指挥官强化"
            />
          </>
        ) : (
          <InspectorPlaceholder title="战斗详情" />
        )}
      </div>
    );
  }

  if (selection?.kind === "ability") {
    const { ability } = selection;
    const name =
      ability.nameZhCN?.split(" /// ")[0]?.trim() ||
      ability.nameEnUS ||
      ability.id;
    return (
      <div className="detail-inspector-content">
        <div className="detail-inspector-identity">
          <img alt="" draggable="false" src={ability.iconDataUrl} />
          <div>
            <strong>{name}</strong>
            <CopyableInspectorId value={ability.abilityId} />
          </div>
        </div>
        <section className="detail-inspector-section">
          <header><strong>效果</strong></header>
          <p>{sc2TooltipToText(ability.tooltipZhCN || ability.tooltipEnUS) || "暂无效果说明"}</p>
        </section>
      </div>
    );
  }

  return null;
}

export function AppliedChangeHistory({
  changes,
  error,
}: {
  changes: AppliedChangeSummary[];
  error: string;
}) {
  const visibleChanges = [...changes].sort((left, right) =>
    left.plan.appliedAt.localeCompare(right.plan.appliedAt) || left.id.localeCompare(right.id));
  return (
    <section className="detail-change-summary">
      <header>
        <div>
          <span>修改记录</span>
          <strong>全部改动</strong>
        </div>
        <small>{visibleChanges.length}</small>
      </header>
      {error ? <ErrorNotice error={error} title="改动记录暂时无法读取" hint="请点击“重新检查并刷新”，确认当前项目的数据库状态。" /> : visibleChanges.length ? (
        <ul className="detail-change-list">
          {visibleChanges.map((change) => (
            <li key={change.id}>
              <p>{change.text}</p>
              <ChangeDetails change={change} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="detail-change-empty">当前没有已写入的改动。</p>
      )}
    </section>
  );
}

const CHANGE_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function displayChangeValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

function ChangeDetails({ change }: { change: AppliedChangeSummary }) {
  const before = displayChangeValue(change.before);
  const after = displayChangeValue(change.after);
  const applied = new Date(change.plan.appliedAt);
  const appliedAt = Number.isNaN(applied.getTime()) ? "" : CHANGE_DATE_FORMAT.format(applied);
  return (
    <div className="detail-change-meta">
      <div className="detail-change-facts">
        {before !== null && after !== null ? <span>{before} → {after}</span> : null}
        {appliedAt ? <time dateTime={change.plan.appliedAt}>{appliedAt}</time> : null}
      </div>
    </div>
  );
}

function CopyableInspectorId({ value }: { value: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyState === "idle") return undefined;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyId = async () => {
    try {
      await invoke("clipboard_write", { text: value });
      setCopyState("copied");
    } catch (nativeError) {
      try {
        await navigator.clipboard.writeText(value);
        setCopyState("copied");
      } catch {
        console.error("Unable to copy inspector ID", nativeError);
        setCopyState("failed");
      }
    }
  };

  return (
    <div className="detail-inspector-id">
      <span className="detail-inspector-id-label">ID：</span>
      <code
        aria-label={`ID ${value}，右键复制`}
        onContextMenu={(event) => {
          event.preventDefault();
          void copyId();
        }}
        title={`${value}\n右键复制完整 ID`}
      >
        {value}
      </code>
      <span
        aria-live="polite"
        className={`detail-inspector-copy-state is-${copyState}`}
      >
        {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "右键复制"}
      </span>
    </div>
  );
}

function InspectorPlaceholder({ title }: { title: string }) {
  return (
    <section className="detail-inspector-section is-placeholder">
      <header><strong>{title}</strong></header>
      <p>详细数据将在下一步接入。</p>
    </section>
  );
}

function InspectorDetailSection({
  emptyText,
  items,
  title,
}: {
  emptyText?: string;
  items: CommanderUnitDetailItem[];
  title: string;
}) {
  return (
    <section className="detail-inspector-section">
      <header><strong>{title}</strong></header>
      {items.length ? <ul className="detail-inspector-list">
        {items.map((item) => (
          <li key={item.ids.join("|")}>
            <strong>
              {item.nameZhCN}
              {item.level ? <span>等级 {item.level}</span> : null}
            </strong>
            <code>{item.ids.join(" · ")}</code>
            {item.facts?.length ? (
              <dl className="detail-inspector-facts">
                {item.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p>{sc2TooltipToText(item.descriptionZhCN)}</p>
          </li>
        ))}
      </ul> : <p className="detail-inspector-empty-copy">{emptyText ?? "暂无关联数据。"}</p>}
    </section>
  );
}
