import { getLanguage, t, tx, useLanguage } from "../../i18n/index";
import { ErrorNotice } from "../common/ErrorNotice";
import { useState } from "react";
import { ChevronDown, History, MessageSquarePlus, Trash2 } from "lucide-react";
import type { AgentSessionSummary } from "../../features/agent/types";
import "./SessionSidebar.css";

type Props = {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  activeTitle: string;
  loading: boolean;
  reading: boolean;
  deletingSessionId: string | null;
  error: string;
  disabled: boolean;
  onNew: () => void;
  onSelect: (session: AgentSessionSummary) => void;
  onDelete: (session: AgentSessionSummary) => void;
};

function sessionTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return t("时间未知");
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat(getLanguage(), {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : new Intl.DateTimeFormat(getLanguage(), {
        year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
        month: "numeric",
        day: "numeric",
      }).format(date);
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  activeTitle,
  loading,
  reading,
  deletingSessionId,
  error,
  disabled,
  onNew,
  onSelect,
  onDelete,
}: Props) {
  useLanguage();
  const [historyExpanded, setHistoryExpanded] = useState(true);

  return (
    <section
      className={`session-sidebar${historyExpanded ? "" : " collapsed"}`}
      aria-label={t("Agent 会话管理")}
    >
      <header className="session-sidebar-header">
        <div>
          <span>{t("会话")}</span>
          <strong>{t("对话会话")}</strong>
        </div>
        <button
          aria-label={t("新建会话")}
          disabled={disabled}
          onClick={onNew}
          title={t("新建会话")}
          type="button"
        >
          <MessageSquarePlus size={15} />
        </button>
      </header>

      <div className="current-session-card">
        <span className={`session-status-dot${activeSessionId ? " connected" : ""}`} />
        <div>
          <small>{t("当前会话")}</small>
          <strong>{reading ? t("正在载入…") : activeSessionId ? activeTitle : t(activeTitle)}</strong>
          <code>{activeSessionId ?? t("发送第一条消息后创建")}</code>
        </div>
      </div>

      <button
        aria-expanded={historyExpanded}
        className="session-history-heading"
        onClick={() => setHistoryExpanded((expanded) => !expanded)}
        type="button"
      >
        <span><History size={13} />{t("历史会话")}</span>
        <span className="session-history-summary">
          <small>{loading ? "…" : sessions.length}</small>
          <ChevronDown className="session-history-chevron" size={13} />
        </span>
      </button>

      {historyExpanded ? (
        <div className="session-history-list" aria-busy={loading || reading}>
          {loading ? (
            <p className="session-list-state">{t("正在读取真实会话…")}</p>
          ) : sessions.length ? (
            sessions.map((session) => {
              const selected = session.id === activeSessionId;
              const deleting = session.id === deletingSessionId;
              return (
                <div
                  className={`session-history-item${selected ? " selected" : ""}`}
                  key={session.id}
                >
                  <button
                    className="session-history-select"
                    disabled={disabled || reading || deleting}
                    onClick={() => onSelect(session)}
                    title={`${session.title}\n${session.id}`}
                    type="button"
                  >
                    <strong>{session.title}</strong>
                    <span>{sessionTimestamp(session.updatedAtMs)}</span>
                  </button>
                  <button
                    aria-label={tx`删除会话：${session.title}`}
                    className="session-history-delete"
                    disabled={disabled || reading || deleting}
                    onClick={() => onDelete(session)}
                    title={t("永久删除这个 OpenCode 会话")}
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          ) : (
            <p className="session-list-state">{t("还没有历史会话")}</p>
          )}
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} title={t("会话操作遇到问题")} hint={t("请等待当前任务结束后重试；持续失败时可重新打开项目。")} /> : null}
    </section>
  );
}
