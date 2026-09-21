import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, MessageSquareText, Square, TerminalSquare } from "lucide-react";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import { OpenCodeTerminal } from "../../OpenCodeTerminal";
import { MarkdownMessage } from "./MarkdownMessage";
import "./ChatPanel.css";

type Props = {
  active: boolean;
  agent: AgentController;
  environment: Sc2EnvironmentController;
};

function AgentPresence({ isThinking = false }: { isThinking?: boolean }) {
  return (
    <span
      className={`agent-presence${isThinking ? " is-thinking" : ""}`}
      aria-hidden="true"
    >
      <span className="agent-presence-core" />
    </span>
  );
}

export function ChatPanel({ active, agent, environment }: Props) {
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const messagesRef = useRef<HTMLDivElement>(null);
  const keepMessagesPinned = useRef(true);

  useEffect(() => {
    if (!environment.agentReady && view === "terminal") setView("chat");
  }, [environment.agentReady, view]);

  useEffect(() => {
    setView("chat");
    keepMessagesPinned.current = true;
  }, [agent.conversationResetToken]);

  useLayoutEffect(() => {
    const messageList = messagesRef.current;
    if (messageList && keepMessagesPinned.current) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }, [active, agent.isThinking, agent.messages]);

  return (
    <div className="conversation">
      <button
        className="conversation-view-toggle"
        aria-label={view === "chat" ? "切换到 OpenCode 终端" : "切换到对话"}
        aria-pressed={view === "terminal"}
        disabled={!environment.agentReady}
        onClick={() => setView((current) => current === "chat" ? "terminal" : "chat")}
        type="button"
      >
        {view === "chat" ? <TerminalSquare size={13} /> : <MessageSquareText size={13} />}
        {view === "chat" ? "终端" : "对话"}
      </button>

      <div
        className={`conversation-chat${view === "terminal" ? " is-hidden" : ""}`}
        aria-hidden={view === "terminal"}
      >
        <div
          className="messages"
          ref={messagesRef}
          onScroll={(event) => {
            const messageList = event.currentTarget;
            const distanceFromBottom =
              messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
            keepMessagesPinned.current = distanceFromBottom < 24;
          }}
        >
          {agent.messages.map((message) => (
            <article
              className={`message ${message.role}${message.status ? ` ${message.status}` : ""}`}
              aria-label={message.status === "thinking" ? "CoopAgent 正在思考" : undefined}
              aria-live={message.status === "thinking" ? "polite" : undefined}
              key={message.id}
            >
              {message.role === "assistant" ? (
                <AgentPresence isThinking={message.status === "thinking"} />
              ) : (
                <div className="message-avatar user"><span>你</span></div>
              )}
              {(message.status === "thinking" ? message.thinkingHint : message.text) && (
                <div className="message-body">
                  {message.status === "thinking" ? (
                    <p className="thinking-hint">{message.thinkingHint}</p>
                  ) : message.role === "assistant" ? (
                    <MarkdownMessage>{message.text}</MarkdownMessage>
                  ) : (
                    <p>{message.text}</p>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="composer-wrap">
          {!environment.agentReady && (
            <div className="agent-setup-gate" role="status">
              <AlertTriangle size={18} />
              <div>
                <strong>{environment.status ? "Agent 尚未解锁" : "正在检查 StarCraft II 安装"}</strong>
                <span>{environment.status?.message ?? "正在读取本机配置，请稍候…"}</span>
              </div>
              <button onClick={() => environment.setDialogOpen(true)} type="button">配置路径</button>
            </div>
          )}
          <div className="composer">
            <textarea
              aria-label="向 CoopAgent 描述修改"
              disabled={
                !environment.agentReady
                || agent.isThinking
                || agent.sessionInitializing
                || agent.sessionReading
              }
              value={agent.draft}
              onChange={(event) => agent.setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void agent.sendMessage();
                }
              }}
              placeholder={agent.isApplying
                ? "正在应用 Game A 修改，请稍候…"
                : agent.sessionInitializing || agent.sessionReading
                ? "正在恢复 Session…"
                : environment.agentReady
                  ? agent.task?.status === "awaiting_confirmation"
                    ? "回复 Agent 的确认问题，或纠正目标与效果…" : "输入修改指令…"
                  : "请先准备合作模式数据库"}
              rows={1}
            />
            <div className="composer-footer">
              {agent.agentRunning ? <button
                className="send-button"
                aria-label={agent.isCancelling ? "正在停止" : "停止 Agent"}
                title="停止模型任务；已进入提交的任务仍由后端安全处理"
                disabled={agent.isCancelling}
                onClick={() => void agent.cancelAgent()}
                type="button"
              ><Square size={15} fill="currentColor" /></button> : <button
                className="send-button"
                aria-label="发送"
                disabled={
                  !agent.draft.trim()
                  || agent.isThinking
                  || agent.sessionInitializing
                  || agent.sessionReading
                  || !environment.agentReady
                }
                onClick={() => void agent.sendMessage()}
                type="button"
              >
                <ArrowUp size={18} strokeWidth={2.2} />
              </button>}
            </div>
          </div>
          <p className="composer-hint">修改请求会先预检，再由 Agent 明确提交；写入后由你决定何时试玩。</p>
        </div>
      </div>

      <OpenCodeTerminal active={active && environment.agentReady && view === "terminal"} />
    </div>
  );
}
