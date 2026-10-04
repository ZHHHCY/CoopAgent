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
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间未知";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : new Intl.DateTimeFormat("zh-CN", {
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
  const [historyExpanded, setHistoryExpanded] = useState(true);

  return (
    <section
      className={`session-sidebar${historyExpanded ? "" : " collapsed"}`}
      aria-label="Agent 会话管理"
    >
      <header className="session-sidebar-header">
        <div>
          <span>会话</span>
          <strong>对话会话</strong>
        </div>
        <button
          aria-label="新建会话"
          disabled={disabled}
          onClick={onNew}
          title="新建会话"
          type="button"
        >
          <MessageSquarePlus size={15} />
        </button>
      </header>

      <div className="current-session-card">
        <span className={`session-status-dot${activeSessionId ? " connected" : ""}`} />
        <div>
          <small>当前会话</small>
          <strong>{reading ? "正在载入…" : activeTitle}</strong>
          <code>{activeSessionId ?? "发送第一条消息后创建"}</code>
        </div>
      </div>

      <button
        aria-expanded={historyExpanded}
        className="session-history-heading"
        onClick={() => setHistoryExpanded((expanded) => !expanded)}
        type="button"
      >
        <span><History size={13} />历史会话</span>
        <span className="session-history-summary">
          <small>{loading ? "…" : sessions.length}</small>
          <ChevronDown className="session-history-chevron" size={13} />
        </span>
      </button>

      {historyExpanded ? (
        <div className="session-history-list" aria-busy={loading || reading}>
          {loading ? (
            <p className="session-list-state">正在读取真实会话…</p>
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
                    aria-label={`删除会话：${session.title}`}
                    className="session-history-delete"
                    disabled={disabled || reading || deleting}
                    onClick={() => onDelete(session)}
                    title="永久删除这个 OpenCode 会话"
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })
          ) : (
            <p className="session-list-state">还没有历史会话</p>
          )}
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} title="会话操作遇到问题" hint="请等待当前任务结束后重试；持续失败时可重新打开项目。" /> : null}
    </section>
  );
}
