import { useProjectBridge } from "../projects/projectBridge";
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

export type Sc2InstallationCheck = {
  id: string;
  label: string;
  passed: boolean;
  path?: string;
};

export type Sc2InstallationStatus = {
  configured: boolean;
  valid: boolean;
  databaseReady: boolean;
  databaseBuild?: string;
  rootPath?: string;
  build?: string;
  editorPath?: string;
  gamePath?: string;
  checks: Sc2InstallationCheck[];
  message: string;
  configPath: string;
};

type GameAEditorLaunchResult = {
  status: "ok";
  editor: "launched";
  runId: string;
  tracePath: string;
};

export function useSc2Environment() {
  const { invoke } = useProjectBridge();
  const [status, setStatus] = useState<Sc2InstallationStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [launchStatus, setLaunchStatus] = useState<
    "idle" | "launching" | "launched" | "error"
  >("idle");
  const [launchError, setLaunchError] = useState("");

  useEffect(() => {
    if (!isTauri()) {
      setStatus({
        configured: false,
        valid: false,
        databaseReady: false,
        checks: [],
        message: "安装路径只能在 CoopAgent 桌面版中配置。",
        configPath: "用户配置目录",
      });
      return;
    }
    invoke<Sc2InstallationStatus>("sc2_installation_status")
      .then(setStatus)
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  const gameReady = status?.valid === true;
  const agentReady = gameReady || status?.databaseReady === true;

  async function chooseInstallation(agentBusy: boolean) {
    if (agentBusy) {
      setError("Agent 运行期间不能切换环境或 Session。");
      return false;
    }
    if (!isTauri()) {
      setError("安装路径只能在 CoopAgent 桌面版中配置。");
      return false;
    }
    setSelecting(true);
    setError("");
    try {
      const selection = await openDialog({
        directory: true,
        multiple: false,
        title: "选择 StarCraft II 安装文件夹",
        defaultPath: status?.rootPath,
      });
      if (typeof selection !== "string") return false;
      const nextStatus = await invoke<Sc2InstallationStatus>("sc2_installation_set", {
        rootPath: selection,
      });
      setStatus(nextStatus);
      setLaunchStatus("idle");
      setLaunchError("");
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setSelecting(false);
    }
  }

  async function launchEditor() {
    if (!gameReady || launchStatus === "launching") return;
    if (!isTauri()) {
      setLaunchStatus("error");
      setLaunchError("只能在 CoopAgent 桌面版中启动 Game A。");
      return;
    }

    setLaunchStatus("launching");
    setLaunchError("");
    try {
      await invoke<GameAEditorLaunchResult>("game_a_editor_launch");
      setLaunchStatus("launched");
    } catch (reason) {
      setLaunchStatus("error");
      setLaunchError(String(reason));
    }
  }

  return {
    agentReady,
    chooseInstallation,
    dialogOpen,
    error,
    gameReady,
    launchError,
    launchEditor,
    launchStatus,
    selecting,
    setDialogOpen,
    status,
  };
}

export type Sc2EnvironmentController = ReturnType<typeof useSc2Environment>;
