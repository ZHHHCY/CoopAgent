import { t, useLanguage } from "../../i18n/index";
import { useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import './ErrorNotice.css';

export function OpenLogsButton() {
  useLanguage();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  async function open() {
    setOpening(true); setFailed(false);
    try { await invoke('open_log_directory'); }
    catch { setFailed(true); }
    finally { setOpening(false); }
  }
  return <span className="open-logs">
    <button type="button" disabled={opening || !isTauri()} onClick={() => void open()}>
      {opening ? t("正在打开…") : t("打开日志目录")}
    </button>
    {failed && <small role="status">{t("未能打开，请手动进入 CoopAgent 目录下的 .coopagent/logs。")}</small>}
  </span>;
}

// The caller knows the failed operation. Keep the original error available
// without guessing its cause from natural-language or platform-specific strings.
export function ErrorNotice({ error, title, hint }: { error: string; title: string; hint: string }) {
  useLanguage();
  if (!error) return null;
  return <div className="error-notice" role="alert">
    <strong>{title}</strong>
    <p>{hint}</p>
    <details><summary>{t("查看技术详情")}</summary><pre>{error}</pre></details>
    <OpenLogsButton />
  </div>;
}
