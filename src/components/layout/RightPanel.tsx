import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import { AppliedChangeHistory } from "../commander/CommanderDetailInspector";
import type { AppliedChangeSummary } from "../commander/types";
import { GameActions } from "./GameActions";
import "./RightPanel.css";

type Props = {
  agent: AgentController;
  changeError: string;
  changes: AppliedChangeSummary[];
  environment: Sc2EnvironmentController;
};

export function RightPanel({ agent, changeError, changes, environment }: Props) {
  const plan = agent.pendingPlan;
  return (
    <aside className="plan-panel">
      <div className="right-panel-history">
        <AppliedChangeHistory changes={changes} error={changeError} />
      </div>

      {plan?.status === "error" && (
        <div className="plan-submission-notice">
          <p className="plan-error" role="alert">最近一次提交未成功：{plan.error ?? "请继续对话处理。"}</p>
          {!["stale", "cancelled"].includes(plan.submissionState ?? "") && (
            <button className="apply-button" disabled={agent.isThinking}
              onClick={() => void agent.applyPendingPlan()} type="button">重试提交</button>
          )}
        </div>
      )}

      <GameActions environment={environment} />
    </aside>
  );
}
