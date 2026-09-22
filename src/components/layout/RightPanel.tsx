import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import { AppliedChangeHistory } from "../commander/CommanderDetailInspector";
import type { AppliedChangeSummary } from "../commander/types";
import { GameActions } from "./GameActions";
import { ErrorNotice } from "../common/ErrorNotice";
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
        {changeError && <button type="button" disabled={environment.checking}
          onClick={() => void environment.refresh()}>{environment.checking ? "正在检查…" : "重新检查并刷新"}</button>}
      </div>

      {plan?.status === "error" && (
        <div className="plan-submission-notice">
          <ErrorNotice error={plan.error ?? "未收到成功提交的结果。"} title="最近一次提交未成功"
            hint="请在对话中继续处理；下方提供重试时，也可以重试原提交。" />
          {!["stale", "cancelled"].includes(plan.submissionState ?? "") && (
            <button className="apply-button" disabled={agent.isThinking}
              onClick={() => void agent.applyPendingPlan()} type="button">重试提交</button>
          )}
        </div>
      )}

      <GameActions environment={environment} agent={agent} />
    </aside>
  );
}
