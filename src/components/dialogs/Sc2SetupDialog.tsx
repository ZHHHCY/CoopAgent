import { t, useLanguage } from "../../i18n/index";
import { ErrorNotice } from "../common/ErrorNotice";
import { AlertTriangle, CheckCircle2, FolderOpen, X } from "lucide-react";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import "./Dialogs.css";

type Props = {
  agent: AgentController;
  environment: Sc2EnvironmentController;
};

export function Sc2SetupDialog({ agent, environment }: Props) {
  useLanguage();
  if (!environment.dialogOpen) return null;

  async function chooseInstallation() {
    const changed = await environment.chooseInstallation(agent.isThinking);
    if (changed) {
      agent.beginNewAgentSession(
        t("StarCraft II 环境已更新，下一条消息将使用新的 Agent 会话。"),
      );
    }
  }

  return (
    <div
      className="model-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !environment.selecting) {
          environment.setDialogOpen(false);
        }
      }}
      role="presentation"
    >
      <section
        aria-label={t("配置星际争霸 II 路径")}
        aria-modal="true"
        className="model-dialog sc2-dialog"
        role="dialog"
      >
        <header className="model-dialog-header">
          <div>
            <span className="eyebrow">{t("游戏安装")}</span>
            <h2>{t("配置星际争霸 II 路径")}</h2>
          </div>
          <button
            aria-label={t("关闭")}
            disabled={environment.selecting}
            onClick={() => environment.setDialogOpen(false)}
            type="button"
          >
            <X size={18} />
          </button>
        </header>

        <div className="sc2-dialog-body">
          <p className="model-dialog-intro">{t("请选择名为 StarCraft II 的游戏安装文件夹。CoopAgent 会验证本地 CASC 数据、编辑器与游戏核心。已有合作模式数据库时， 无需安装游戏也可使用 Agent 和 UI；启动编辑器仍需要有效的游戏路径。")}</p>

          <div className={`sc2-path-summary${environment.gameReady ? " ready" : ""}`}>
            {environment.gameReady ? <CheckCircle2 size={19} /> : <FolderOpen size={19} />}
            <div>
              <strong>{t(environment.status?.message ?? "尚未检查安装目录")}</strong>
              <span>{environment.status?.rootPath ?? t("尚未选择文件夹")}</span>
            </div>
          </div>

          {environment.status?.checks.length ? (
            <div className="sc2-check-list">
              {environment.status.checks.map((check) => (
                <div className={check.passed ? "passed" : "failed"} key={check.id}>
                  {check.passed ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                  <span>
                    <strong>{t(check.label)}</strong>
                    <small>{check.path ?? t("未找到")}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="sc2-check-empty">{t("选择文件夹后，这里会逐项显示验证结果。")}</div>
          )}

          {environment.error && <ErrorNotice error={environment.error} title={t("环境检查未完成")} hint={t("请核对游戏目录，再点击“重新检查”；数据库缺失时重新运行 setup.cmd。")} />}
          <div className="model-storage-hint">
            <strong>{t(environment.status?.databaseStatus?.message ?? '')}</strong>
            <small>{t("数据库：")}{environment.status?.databaseStatus?.databaseFile ?? t("尚未检查")}</small>
          </div>
          <div className="model-storage-hint">
            <small>{t("路径配置：")}{t(environment.status?.configPath ?? "用户配置目录")}</small>
          </div>
          <div className="model-dialog-actions">
            <button className="secondary-dialog-button" disabled={environment.checking || environment.selecting}
              onClick={() => void environment.refresh()} type="button">{environment.checking ? t("正在检查…") : t("重新检查")}</button>
            <button
              className="secondary-dialog-button"
              disabled={environment.selecting}
              onClick={() => environment.setDialogOpen(false)}
              type="button"
            >
              {environment.gameReady ? t("完成") : t("稍后配置")}
            </button>
            <button
              className="primary-dialog-button"
              disabled={environment.selecting}
              onClick={() => void chooseInstallation()}
              type="button"
            >
              <FolderOpen size={15} />
              {environment.selecting ? t("正在验证…") : environment.gameReady ? t("重新选择") : t("选择文件夹")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
