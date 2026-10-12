import { t, useLanguage } from "../../i18n/index";
import { useEffect, useLayoutEffect, useRef } from "react";
import { AlertTriangle, ArrowUp, Square } from "lucide-react";
import type { AgentController } from "../../features/agent/useAgentController";
import type { Sc2EnvironmentController } from "../../features/environment/useSc2Environment";
import { MarkdownMessage } from "./MarkdownMessage";
import { ErrorNotice } from "../common/ErrorNotice";
import { localizeThinkingHint } from "../../features/agent/thinking-hints";
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
  useLanguage();
  const messagesRef = useRef<HTMLDivElement>(null);
  const keepMessagesPinned = useRef(true);

  useEffect(() => {
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
      <div className="conversation-chat">
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
              aria-label={message.status === "thinking" ? t("CoopAgent 正在思考") : undefined}
              aria-live={message.status === "thinking" ? "polite" : undefined}
              key={message.id}
            >
              {message.role === "assistant" ? (
                <AgentPresence isThinking={message.status === "thinking"} />
              ) : (
                <div className="message-avatar user"><span>{t("你")}</span></div>
              )}
              {(message.status === "thinking" ? message.thinkingHint : message.text || message.errorDetails) && (
                <div className="message-body">
                  {message.status === "thinking" ? (
                    <p className="thinking-hint">{localizeThinkingHint(message.thinkingHint ?? '')}</p>
                  ) : message.role === "assistant" ? (
                    <>
                      {message.text && <MarkdownMessage>{message.id === 'coopagent-welcome' ? t(message.text) : message.text}</MarkdownMessage>}
                      {message.errorDetails && <ErrorNotice error={message.errorDetails} title={t("本次请求未完成")}
                        hint={t("请检查模型配置或网络后重试；已写入的修改以右侧记录为准。")} />}
                    </>
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
                <strong>{environment.status ? t("Agent 尚未解锁") : t("正在检查 StarCraft II 安装")}</strong>
                <span>{t(environment.status?.message ?? "正在读取本机配置，请稍候…")}</span>
              </div>
              <button onClick={() => environment.setDialogOpen(true)} type="button">{t("配置路径")}</button>
            </div>
          )}
          <div className="composer">
            <textarea
              aria-label={t("向 CoopAgent 描述修改")}
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
                ? t("正在应用地图运行层修改，请稍候…")
                : agent.sessionInitializing || agent.sessionReading
                ? t("正在恢复会话…")
                : environment.agentReady
                  ? agent.task?.status === "awaiting_confirmation"
                    ? t("回复 Agent 的确认问题，或纠正目标与效果…") : t("输入修改指令…")
                  : t("请先准备合作模式数据库")}
              rows={1}
            />
            <div className="composer-footer">
              {agent.agentRunning ? <button
                className="send-button"
                aria-label={agent.isCancelling ? t("正在停止") : t("停止 Agent")}
                title={t("停止模型任务；已进入提交的任务仍由后端安全处理")}
                disabled={agent.isCancelling}
                onClick={() => void agent.cancelAgent()}
                type="button"
              ><Square size={15} fill="currentColor" /></button> : <button
                className="send-button"
                aria-label={t("发送")}
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
          <p className="composer-hint">{t("修改请求会先预检，再由 Agent 明确提交；写入后由你决定何时试玩。")}</p>
        </div>
      </div>

    </div>
  );
}
