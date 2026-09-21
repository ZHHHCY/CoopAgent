import { KeyRound, Plus, Trash2, X } from "lucide-react";
import type { ModelController } from "../../features/models/useModelCatalog";
import "./Dialogs.css";

type Props = {
  models: ModelController;
};

export function ModelDialog({ models }: Props) {
  if (!models.dialog) return null;

  return (
    <div
      className="model-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !models.saving) models.setDialog(null);
      }}
      role="presentation"
    >
      <section
        aria-label={models.dialog === "add" ? "新增模型" : "管理模型"}
        aria-modal="true"
        className="model-dialog"
        role="dialog"
      >
        <header className="model-dialog-header">
          <div>
            <span className="eyebrow">MODEL PROVIDER</span>
            <h2>{models.dialog === "add" ? "接入自己的模型" : "管理模型"}</h2>
          </div>
          <button
            aria-label="关闭"
            disabled={models.saving}
            onClick={() => models.setDialog(null)}
            type="button"
          >
            <X size={18} />
          </button>
        </header>

        {models.dialog === "add" ? (
          <div className="model-form">
            <p className="model-dialog-intro">
              当前支持 OpenAI-compatible 的 Chat Completions 接口。API Key
              保存到 OpenCode 用户凭据文件，不写入项目仓库。
            </p>
            <div className="model-form-grid">
              <label>
                <span>Provider ID</span>
                <input
                  autoComplete="off"
                  onChange={(event) => models.updateDraft(
                    "providerId",
                    event.currentTarget.value.toLowerCase(),
                  )}
                  placeholder="例如 my-provider"
                  value={models.draft.providerId}
                />
                <small>只能使用小写字母、数字和连字符。</small>
              </label>
              <label>
                <span>Provider 名称</span>
                <input
                  onChange={(event) => models.updateDraft("providerName", event.currentTarget.value)}
                  placeholder="例如 我的模型服务"
                  value={models.draft.providerName}
                />
              </label>
              <label className="model-form-wide">
                <span>Base URL</span>
                <input
                  autoComplete="url"
                  onChange={(event) => models.updateDraft("baseUrl", event.currentTarget.value)}
                  placeholder="https://example.com/v1"
                  value={models.draft.baseUrl}
                />
              </label>
              <label>
                <span>模型 ID</span>
                <input
                  autoComplete="off"
                  onChange={(event) => models.updateDraft("modelId", event.currentTarget.value)}
                  placeholder="例如 qwen3-coder"
                  value={models.draft.modelId}
                />
              </label>
              <label>
                <span>显示名称</span>
                <input
                  onChange={(event) => models.updateDraft("modelName", event.currentTarget.value)}
                  placeholder="例如 Qwen3 Coder"
                  value={models.draft.modelName}
                />
              </label>
              <label className="model-form-wide">
                <span>API Key（本地模型可留空）</span>
                <div className="secret-input">
                  <KeyRound size={16} />
                  <input
                    autoComplete="new-password"
                    onChange={(event) => models.updateDraft("apiKey", event.currentTarget.value)}
                    placeholder="sk-…"
                    type="password"
                    value={models.draft.apiKey}
                  />
                </div>
              </label>
            </div>
            {models.error && <p className="model-error">{models.error}</p>}
            <div className="model-dialog-actions">
              <button
                className="secondary-dialog-button"
                disabled={models.saving}
                onClick={() => models.setDialog(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-dialog-button"
                disabled={
                  models.saving
                  || !models.draft.providerId.trim()
                  || !models.draft.providerName.trim()
                  || !models.draft.baseUrl.trim()
                  || !models.draft.modelId.trim()
                  || !models.draft.modelName.trim()
                }
                onClick={() => void models.save()}
                type="button"
              >
                {models.saving ? "正在保存…" : "保存并使用"}
              </button>
            </div>
          </div>
        ) : (
          <div className="model-manager">
            <p className="model-dialog-intro">
              选择主对话使用的模型。切换后下一条消息会开启新的 Agent 会话。
            </p>
            <div className="model-list">
              {models.catalog?.models.length ? (
                models.catalog.models.map((model) => (
                  <article
                    className={`model-list-item${model.selected ? " selected" : ""}`}
                    key={model.fullId}
                  >
                    <button
                      className="model-list-select"
                      onClick={() => void models.select(model)}
                      type="button"
                    >
                      <span className={model.selected ? "status-dot ready" : "status-dot"} />
                      <span>
                        <strong>{model.modelName}</strong>
                        <small>{model.fullId}</small>
                        <small>{model.baseUrl}</small>
                      </span>
                    </button>
                    <span className="model-key-state">
                      <KeyRound size={13} />
                      {model.hasApiKey ? "已配置" : "无密钥"}
                    </span>
                    <button
                      aria-label={`删除 ${model.modelName}`}
                      className="model-delete-button"
                      onClick={() => void models.remove(model)}
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  </article>
                ))
              ) : (
                <div className="model-list-empty">
                  <KeyRound size={22} />
                  <strong>还没有自定义模型</strong>
                  <span>添加 OpenAI-compatible 服务后即可在主对话使用。</span>
                </div>
              )}
            </div>
            {models.error && <p className="model-error">{models.error}</p>}
            <div className="model-storage-hint">
              <small>模型配置：{models.catalog?.configPath ?? "用户配置目录"}</small>
              <small>凭据：{models.catalog?.credentialPath ?? "OpenCode auth.json"}</small>
            </div>
            <div className="model-dialog-actions">
              <button
                className="secondary-dialog-button"
                onClick={() => models.setDialog(null)}
                type="button"
              >
                完成
              </button>
              <button className="primary-dialog-button" onClick={models.openAdd} type="button">
                <Plus size={15} />
                新增模型
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
