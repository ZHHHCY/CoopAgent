import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  Settings2,
} from "lucide-react";
import coopAgentIcon from "../../assets/coopagent-icon.png";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import type { ModelController } from "../../features/models/useModelCatalog";
import { SessionSidebar } from "../sessions/SessionSidebar";
import "./AppSidebar.css";

type Props = {
  agent: AgentController;
  environment: Sc2EnvironmentController;
  models: ModelController;
};

const TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function TokenUsageRow({
  label,
  usage,
  total = false,
}: {
  label: string;
  usage: AgentController["sessionUsage"]["total"];
  total?: boolean;
}) {
  const exact = `i ${usage.input.toLocaleString()}，cached ${usage.cached.toLocaleString()}，o ${usage.output.toLocaleString()}`;
  return (
    <div
      aria-label={`${label}：${exact}`}
      className={`session-token-row${total ? " total" : ""}`}
      title={exact}
    >
      <span className="session-token-label">{label}</span>
      <span><b>i</b> {TOKEN_FORMAT.format(usage.input)}</span>
      <span><b>cached</b> {TOKEN_FORMAT.format(usage.cached)}</span>
      <span><b>o</b> {TOKEN_FORMAT.format(usage.output)}</span>
    </div>
  );
}

export function AppSidebar({ agent, environment, models }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img alt="" src={coopAgentIcon} />
        </div>
        <div>
          <strong>COOP AGENT</strong>
          <span>SC2 co-op workbench</span>
        </div>
      </div>

      <button
        className={`project-picker${environment.agentReady ? " ready" : " needs-setup"}`}
        onClick={() => environment.setDialogOpen(true)}
        type="button"
      >
        <div className="project-icon">
          <FolderOpen size={17} />
        </div>
        <div>
          <span>星际争霸 II / 数据库</span>
          <strong>
            {environment.gameReady
              ? `已验证${environment.status?.build ? ` · ${environment.status.build}` : ""}`
              : environment.status?.databaseReady
                ? `离线数据库${environment.status.databaseBuild ? ` · ${environment.status.databaseBuild}` : ""}`
                : environment.status?.configured
                  ? "路径验证失败"
                  : "点击配置路径"}
          </strong>
        </div>
        {environment.agentReady ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      </button>

      <SessionSidebar
        activeSessionId={agent.activeSessionId}
        activeTitle={agent.activeSessionTitle}
        deletingSessionId={agent.sessionDeletingId}
        disabled={
          agent.isThinking
          || agent.sessionInitializing
          || agent.sessionsLoading
          || agent.sessionReading
          || Boolean(agent.sessionDeletingId)
        }
        error={agent.sessionError}
        loading={agent.sessionsLoading}
        onDelete={(session) => void agent.deleteAgentSession(session)}
        onNew={() => agent.beginNewAgentSession()}
        onSelect={(session) => void agent.readAgentSession(session.id)}
        reading={agent.sessionReading}
        sessions={agent.agentSessions}
      />

      <button
        aria-label="管理模型"
        className="selected-model-card"
        onClick={models.openManage}
        type="button"
      >
        <span className={models.selectedModel ? "status-dot ready" : "status-dot"} />
        <span className="selected-model-copy">
          <small>当前模型</small>
          <strong>{models.selectedModel?.modelName ?? "尚未接入"}</strong>
        </span>
        <Settings2 className="selected-model-settings" size={15} />
      </button>

      <div className="session-token-usage" aria-label="当前 Session Token 用量">
        <TokenUsageRow label="上一轮" usage={agent.sessionUsage.lastTurn} />
        <TokenUsageRow label="SESSION" total usage={agent.sessionUsage.total} />
      </div>
    </aside>
  );
}
