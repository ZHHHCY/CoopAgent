import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type ModelProfile = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  fullId: string;
  selected: boolean;
  hasApiKey: boolean;
};

export type ModelCatalog = {
  models: ModelProfile[];
  selectedModel?: string;
  configPath: string;
  credentialPath: string;
};

export type ModelDraft = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  apiKey: string;
};

const EMPTY_MODEL_DRAFT: ModelDraft = {
  providerId: "",
  providerName: "",
  baseUrl: "",
  modelId: "",
  modelName: "",
  apiKey: "",
};

type Options = {
  isAgentBusy: boolean;
  onModelChanged: (message: string) => void;
};

export function useModelCatalog({ isAgentBusy, onModelChanged }: Options) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [dialog, setDialog] = useState<"add" | "manage" | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(EMPTY_MODEL_DRAFT);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<ModelCatalog>("model_list")
      .then(setCatalog)
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  const selectedModel = useMemo(
    () => catalog?.models.find((model) => model.selected) ?? null,
    [catalog],
  );

  function openAdd() {
    setDraft(EMPTY_MODEL_DRAFT);
    setError("");
    setDialog("add");
  }

  function openManage() {
    setError("");
    setDialog("manage");
  }

  function updateDraft(field: keyof ModelDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    if (isAgentBusy) {
      setError("Agent 运行期间不能切换模型或会话。");
      return;
    }
    if (!isTauri()) {
      setError("模型配置只能在 CoopAgent 桌面版中使用。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const nextCatalog = await invoke<ModelCatalog>("model_save", { input: draft });
      setCatalog(nextCatalog);
      onModelChanged("模型配置已更新，下一条消息将使用新的 Agent 会话。");
      setDraft(EMPTY_MODEL_DRAFT);
      setDialog("manage");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function select(model: ModelProfile) {
    if (isAgentBusy) {
      setError("Agent 运行期间不能切换模型或会话。");
      return;
    }
    setError("");
    try {
      const nextCatalog = await invoke<ModelCatalog>("model_select", {
        providerId: model.providerId,
        modelId: model.modelId,
      });
      setCatalog(nextCatalog);
      onModelChanged(`已切换到 ${model.modelName}，下一条消息将使用新的 Agent 会话。`);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function remove(model: ModelProfile) {
    if (isAgentBusy) {
      setError("Agent 运行期间不能切换模型或会话。");
      return;
    }
    setError("");
    try {
      const nextCatalog = await invoke<ModelCatalog>("model_delete", {
        providerId: model.providerId,
        modelId: model.modelId,
      });
      setCatalog(nextCatalog);
      onModelChanged("模型配置已变更，下一条消息将使用新的 Agent 会话。");
    } catch (reason) {
      setError(String(reason));
    }
  }

  return {
    catalog,
    dialog,
    draft,
    error,
    openAdd,
    openManage,
    remove,
    save,
    saving,
    select,
    selectedModel,
    setDialog,
    updateDraft,
  };
}

export type ModelController = ReturnType<typeof useModelCatalog>;
