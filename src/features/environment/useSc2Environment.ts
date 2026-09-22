import { useProjectBridge } from "../projects/projectBridge";
import { useCallback, useEffect, useState } from "react";
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
  databaseStatus?: { ready: boolean; code: string; message: string; databaseFile?: string; dataBuild?: string };
  rootPath?: string;
  build?: string;
  editorPath?: string;
  gamePath?: string;
  checks: Sc2InstallationCheck[];
  message: string;
  configPath: string;
};

export function useSc2Environment() {
  const { invoke } = useProjectBridge();
  const [status, setStatus] = useState<Sc2InstallationStatus | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(async () => {
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
    setChecking(true);
    setError("");
    try {
      setStatus(await invoke<Sc2InstallationStatus>("sc2_installation_status"));
      setRevision(value => value + 1);
    } catch (reason) { setStatus(null); setError(String(reason)); }
    finally { setChecking(false); }
  }, [invoke]);
  useEffect(() => { void refresh(); }, [refresh]);

  const gameReady = status?.valid === true;
  const agentReady = status?.databaseReady === true;

  async function chooseInstallation(agentBusy: boolean) {
    if (agentBusy) {
      setError("Agent 运行期间不能切换环境或会话。");
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
      setRevision(value => value + 1);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setSelecting(false);
    }
  }

  return {
    agentReady,
    checking,
    refresh,
    revision,
    chooseInstallation,
    dialogOpen,
    error,
    gameReady,
    selecting,
    setDialogOpen,
    status,
  };
}

export type Sc2EnvironmentController = ReturnType<typeof useSc2Environment>;
