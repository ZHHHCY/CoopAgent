import { Play } from "lucide-react";
import { ErrorNotice } from "../common/ErrorNotice";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import type { AgentController } from "../../features/agent/useAgentController";
import { useGameLaunch } from "../../features/environment/useGameLaunch";
import "./GameActions.css";

export function GameActions({ environment, agent }: { environment: Sc2EnvironmentController; agent: AgentController }) {
  const launch = useGameLaunch({ gameReady: environment.gameReady, installation: environment.status?.rootPath ?? '',
    projectRevision: agent.projectRevision, busy: agent.isThinking || agent.sessionInitializing, applying: agent.isApplying });

  return (
    <div className="right-panel-reserved game-actions-area">
      <div className="game-actions" role="group" aria-label="地图与编辑器">
        <span className="game-action-map">当前地图：湮灭快车</span>
        <p className={`game-action-hint ${launch.state}`} role="status">{launch.hint}</p>
        <button
          className={`game-action-button game-action-primary ${launch.state}`}
          disabled={launch.disabled}
          onClick={() => void launch.launch()}
          title={launch.hint}
          type="button"
        >
          <span className="game-action-icon" aria-hidden="true">
            <Play size={18} />
          </span>
          <span className="game-action-copy">
            <small>地图运行层</small>
            <strong>{launch.label}</strong>
          </span>
        </button>
        {launch.error || launch.statusError ? (
          <ErrorNotice error={launch.error || launch.statusError}
            title={launch.error ? "地图准备未完成" : "暂时无法确认编辑器状态"}
            hint="请检查编辑器中的提示后重试；构建失败的原因可在详情或日志中查看。" />
        ) : null}
      </div>
    </div>
  );
}
