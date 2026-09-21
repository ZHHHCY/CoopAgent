import { Map, Play } from "lucide-react";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import "./GameActions.css";

export function GameActions({ environment }: { environment: Sc2EnvironmentController }) {
  const launchLabel = environment.launchStatus === "launching"
    ? "正在启动…"
    : environment.launchStatus === "error"
      ? "重试启动编辑器"
      : environment.launchStatus === "launched"
        ? "编辑器已启动"
        : "启动编辑器";

  return (
    <div className="right-panel-reserved game-actions-area">
      <div className="game-actions" role="group" aria-label="地图与编辑器">
        <button
          className="game-action-button"
          disabled
          title="选择地图功能尚未接入"
          type="button"
        >
          <Map size={17} aria-hidden="true" />
          <span>选择地图</span>
        </button>
        <button
          className={`game-action-button game-action-primary ${environment.launchStatus}`}
          disabled={!environment.gameReady || environment.launchStatus === "launching"}
          onClick={() => void environment.launchEditor()}
          title={environment.launchError || (
            environment.gameReady
              ? "构建最新版 Game A 并在星际编辑器中打开"
              : "请先配置 StarCraft II 路径"
          )}
          type="button"
        >
          <span className="game-action-icon" aria-hidden="true">
            <Play size={18} />
          </span>
          <span className="game-action-copy">
            <small>GAME A</small>
            <strong>{launchLabel}</strong>
          </span>
        </button>
        {environment.launchError ? (
          <p className="game-action-error" role="alert">{environment.launchError}</p>
        ) : null}
      </div>
    </div>
  );
}
