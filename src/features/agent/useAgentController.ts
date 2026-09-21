import { useProjectBridge } from "../projects/projectBridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { PENDING_PLAN_KEY, pendingFromSubmission, restorePendingPlan } from "./pending-plan";
import { messagesFromSnapshot, runIsActive } from "./run-snapshot";
import type {
  AgentEvent,
  AgentTask,
  AgentStatus,
  AgentSessionDetail,
  AgentSessionSummary,
  AgentSessionUsage,
  AgentTokenUsage,
  Message,
  PatchPlanApplyResult,
  PendingPatchPlan,
  SubmissionJob,
} from "./types";

const EMPTY_TOKEN_USAGE: AgentTokenUsage = { input: 0, cached: 0, output: 0 };

function emptySessionUsage(): AgentSessionUsage {
  return { lastTurn: { ...EMPTY_TOKEN_USAGE }, total: { ...EMPTY_TOKEN_USAGE } };
}

function addTokenUsage(current: AgentTokenUsage, added: AgentTokenUsage): AgentTokenUsage {
  return {
    input: current.input + added.input,
    cached: current.cached + added.cached,
    output: current.output + added.output,
  };
}

const WELCOME_MESSAGE: Message = {
  id: "coopagent-welcome",
  role: "assistant",
  text: "你好，我是 CoopAgent。你可以新建或打开项目，用自然语言调整指挥官数值；同一项目的会话共享已有修改。",
};

const THINKING_HINTS = [
  "正在采集晶体矿…",
  "正在采集高能瓦斯…",
  "正在呼叫休伯利安…",
  "正在召唤虫群…",
  "正在集结部队…",
  "激光钻机充能中…",
  "免费的爆虫即将孵化…",
  "正在联络暗影卫队…",
  "正在校准净化光束…",
  "还需要更多生物质…",
  "拉克希尔仪式进行中…",
  "正在引导聚变打击…",
  "感染扩散中…",
  "净化者人格载入中…",
  "正在收集精华…",
  "帝国乐队演奏中…",
  "正在召集亡命之徒…",
  "正在寻找萨尔纳加神器…",
  "正在陪盖瑞玩:)",
  "正在动员帝国劳工…",
] as const;

function freshConversationMessages(extraMessage?: string): Message[] {
  return extraMessage
    ? [
        WELCOME_MESSAGE,
        {
          id: `local-${Date.now()}`,
          role: "assistant",
          text: extraMessage,
        },
      ]
    : [WELCOME_MESSAGE];
}

function pickThinkingHint() {
  const index = Math.floor(Math.random() * THINKING_HINTS.length);
  return THINKING_HINTS[index] ?? THINKING_HINTS[0];
}

export function useAgentController(agentReady: boolean) {
  const { invoke, storage, project, valid } = useProjectBridge();
  const [draft, setDraft] = useState(() => storage.getItem("draft") ?? "");
  useEffect(() => { storage.setItem("draft", draft); }, [draft, storage]);
  const [isThinking, setIsThinking] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [task, setTask] = useState<AgentTask | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [backendStatusKnown, setBackendStatusKnown] = useState(() => !isTauri());
  const [projectRevision, setProjectRevision] = useState(0);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionInitializing, setSessionInitializing] = useState(() => isTauri());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionReading, setSessionReading] = useState(false);
  const [sessionDeletingId, setSessionDeletingId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [pendingPlan, setPendingPlan] = useState<PendingPatchPlan | null>(null);
  const [messages, setMessages] = useState<Message[]>(freshConversationMessages);
  const [sessionUsage, setSessionUsage] = useState<AgentSessionUsage>(emptySessionUsage);
  const [conversationResetToken, setConversationResetToken] = useState(0);

  const agentSessionRef = useRef<string | null>(null);
  const agentRunRef = useRef<{ runId: string; tracePath: string } | null>(null);
  const ignoredTaskRef = useRef<string | null>(storage.getItem("ignored-task-id"));
  const agentChannelRef = useRef<Channel<AgentEvent> | null>(null);
  const sessionRestoreStartedRef = useRef(false);
  const sessionTransitionRef = useRef(0);
  const busyRef = useRef(false);
  const applyingRef = useRef(false);
  const submissionVersionRef = useRef("");
  const submissionReadRef = useRef(false);
  const observationEpochRef = useRef(0);
  const recoveredRunRef = useRef<string | null>(null);
  const usageTurnStartedRef = useRef(true);

  const rememberSession = useCallback((sessionId: string) => {
    agentSessionRef.current = sessionId;
    setActiveSessionId(sessionId);
    try { storage.setItem("coopagent-active-session-id", sessionId); }
    catch { setSessionError("会话已连接，但界面偏好保存失败；后端任务不受影响。"); }
  }, []);

  const rememberPlan = useCallback((plan: PendingPatchPlan) => {
    // Persist synchronously before starting an application, not in a later effect.
    setPendingPlan(plan);
    try { storage.setItem(PENDING_PLAN_KEY, JSON.stringify(plan)); }
    catch { setSessionError("界面状态保存失败；任务结果仍保存在后端。"); }
  }, []);

  const refreshSubmissions = useCallback(async () => {
    if (!isTauri() || submissionReadRef.current) return;
    submissionReadRef.current = true;
    const epoch = observationEpochRef.current;
    try {
      const [status, jobs, savedTask] = await Promise.all([
        invoke<AgentStatus>("agent_snapshot"),
        invoke<SubmissionJob[]>("plan_submission_status"),
        invoke<AgentTask | null>("agent_task_status"),
      ]);
      if (epoch !== observationEpochRef.current) return;
      setBackendStatusKnown(true);
      setSessionError((current) => current.startsWith("无法读取后端任务状态") || current.startsWith("未收到可靠的提交结果") ? "" : current);
      if (status.shutdownError) setSessionError(`暂时无法关闭：${status.shutdownError}`);
      const live = runIsActive(status.run);
      const run = status.run;
      const nextTask = savedTask ?? run?.task ?? null;
      setTask(nextTask?.id === ignoredTaskRef.current ? null : nextTask);
      if (!agentChannelRef.current && run && (live || recoveredRunRef.current === run.runId)) {
        const sameSession = run.sessionId && run.sessionId === agentSessionRef.current;
        const alreadyRecovered = recoveredRunRef.current === run.runId;
        if (!alreadyRecovered) {
          sessionTransitionRef.current += 1;
          setSessionReading(false);
        }
        recoveredRunRef.current = run.runId;
        agentRunRef.current = { runId: run.runId, tracePath: run.tracePath };
        setMessages((current) => messagesFromSnapshot(
          sameSession || alreadyRecovered ? current : freshConversationMessages(), run,
        ));
        if (run.sessionId) rememberSession(run.sessionId);
        setAgentRunning(live);
        if (!live) setIsCancelling(false);
      }
      const active = jobs.some((job) => job.state === "submitted" || job.state === "applying");
      const job = jobs.find((item) => item.state === "submitted" || item.state === "applying") ?? jobs[0];
      if (job) {
        const version = `${job.preparationId}:${job.state}:${job.updatedAt}`;
        if (submissionVersionRef.current !== version) {
          submissionVersionRef.current = version;
          const plan = pendingFromSubmission(job);
          try { rememberPlan(plan); } catch { setPendingPlan(plan); }
          if (job.state === "applied") setProjectRevision((revision) => revision + 1);
        }
      }
      setIsApplying(active);
      if (!agentChannelRef.current && !applyingRef.current) {
        busyRef.current = active || live || status.busy;
        setIsThinking(busyRef.current);
      }
    } catch (error) {
      setSessionError(`无法读取后端任务状态，正在重试：${String(error)}`);
      // An observation failure is not a failed/completed submission.
    } finally { submissionReadRef.current = false; }
  }, [rememberPlan, rememberSession]);

  useEffect(() => {
    if (!isTauri() || sessionInitializing) return;
    void refreshSubmissions();
    const timer = window.setInterval(() => void refreshSubmissions(),
      !backendStatusKnown || isThinking || isApplying ? 1500 : 5000);
    return () => window.clearInterval(timer);
  }, [isThinking, isApplying, backendStatusKnown, sessionInitializing, refreshSubmissions]);

  const refreshAgentSessions = useCallback(async () => {
    if (!isTauri()) return [] as AgentSessionSummary[];
    setSessionsLoading(true);
    setSessionError("");
    try {
      const sessions = await invoke<AgentSessionSummary[]>("agent_session_list", {
        limit: 60,
      });
      setAgentSessions(sessions);
      return sessions;
    } catch (error) {
      setSessionError(String(error));
      return [] as AgentSessionSummary[];
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const readAgentSession = useCallback(async (sessionId: string) => {
    if (!isTauri() || busyRef.current || sessionReading || sessionId === activeSessionId) return;
    const transitionId = ++sessionTransitionRef.current;
    observationEpochRef.current += 1;
    recoveredRunRef.current = null;
    setSessionReading(true);
    setSessionError("");
    try {
      const [session, sessionTask] = await Promise.all([
        invoke<AgentSessionDetail>("agent_session_read", { sessionId }),
        invoke<AgentTask | null>("agent_task_status"),
      ]);
      if (transitionId !== sessionTransitionRef.current) return;
      agentSessionRef.current = session.id;
      setActiveSessionId(session.id);
      storage.setItem("coopagent-active-session-id", session.id);
      setMessages(session.messages.length ? session.messages : freshConversationMessages());
      setSessionUsage(session.usage ?? emptySessionUsage());
      usageTurnStartedRef.current = true;
      setDraft("");
      agentRunRef.current = null;
      const matchingTask = sessionTask?.modelSessionId === session.id ? sessionTask : null;
      ignoredTaskRef.current = matchingTask ? null : sessionTask?.id ?? null;
      if (ignoredTaskRef.current) storage.setItem("ignored-task-id", ignoredTaskRef.current);
      else storage.removeItem("ignored-task-id");
      setTask(matchingTask);
      setConversationResetToken((current) => current + 1);
      if (session.historyTruncated) {
        setSessionError("该 Session 很长，界面只恢复最近 400 条文本消息；Agent 上下文仍完整保留。");
      }
    } catch (error) {
      if (transitionId === sessionTransitionRef.current) setSessionError(String(error));
    } finally {
      if (transitionId === sessionTransitionRef.current) setSessionReading(false);
    }
  }, [activeSessionId, sessionReading, task]);

  const beginNewAgentSession = useCallback((extraMessage?: string) => {
    if (busyRef.current || !backendStatusKnown) return;
    observationEpochRef.current += 1;
    recoveredRunRef.current = null;
    sessionTransitionRef.current += 1;
    agentSessionRef.current = null;
    agentRunRef.current = null;
    agentChannelRef.current = null;
    setActiveSessionId(null);
    setSessionReading(false);
    storage.removeItem("coopagent-active-session-id");
    setMessages(freshConversationMessages(extraMessage));
    setSessionUsage(emptySessionUsage());
    usageTurnStartedRef.current = true;
    setDraft("");
    setSessionError("");
    ignoredTaskRef.current = task?.id ?? null;
    if (ignoredTaskRef.current) storage.setItem("ignored-task-id", ignoredTaskRef.current);
    setTask(null);
    setConversationResetToken((current) => current + 1);
  }, [backendStatusKnown, task]);

  const deleteAgentSession = useCallback(async (session: AgentSessionSummary) => {
    if (!isTauri() || busyRef.current || sessionReading || sessionDeletingId) return;
    const confirmed = window.confirm(
      `确定永久删除这个 OpenCode Session 吗？\n\n${session.title}\n${session.id}\n\n对应的执行 Trace 和已应用 PatchPlan 不会被删除。`,
    );
    if (!confirmed) return;
    setSessionDeletingId(session.id);
    setSessionError("");
    try {
      await invoke("agent_session_delete", { sessionId: session.id });
      if (activeSessionId === session.id) beginNewAgentSession();
      await refreshAgentSessions();
    } catch (error) {
      setSessionError(String(error));
    } finally {
      setSessionDeletingId(null);
    }
  }, [activeSessionId, beginNewAgentSession, isThinking, refreshAgentSessions, sessionDeletingId, sessionReading]);

  useEffect(() => {
    if (!isTauri() || sessionRestoreStartedRef.current) return;
    sessionRestoreStartedRef.current = true;
    void (async () => {
      try {
        const sessions = await refreshAgentSessions();
        const savedSessionId = storage.getItem("coopagent-active-session-id");
        if (savedSessionId && sessions.some((session) => session.id === savedSessionId)) {
          await readAgentSession(savedSessionId);
        } else if (savedSessionId) {
          storage.removeItem("coopagent-active-session-id");
        }
      } catch (error) {
        setSessionError(`无法恢复界面偏好：${String(error)}`);
      } finally {
        let restored = null;
        try { restored = restorePendingPlan(storage.getItem(PENDING_PLAN_KEY)); } catch { /* Backend remains authoritative. */ }
        if (restored) {
          setPendingPlan(restored);
        }
        setSessionInitializing(false);
      }
    })();
  }, [readAgentSession, refreshAgentSessions]);

  const applyCheckedPlan = useCallback(async (checkedPlan: PendingPatchPlan) => {
    if (busyRef.current || !backendStatusKnown || applyingRef.current || agentChannelRef.current || checkedPlan.status === "applied") return;
    if (!isTauri()) {
      setPendingPlan((current) =>
        current
          ? { ...current, status: "error", error: "只能在桌面版中应用 PatchPlan。" }
          : current,
      );
      return;
    }

    applyingRef.current = true;
    observationEpochRef.current += 1;
    busyRef.current = true;
    setIsThinking(true);
    setIsApplying(true);
    try {
      rememberPlan({ ...checkedPlan, status: "applying", error: undefined });
      const result = checkedPlan.preparationId
        ? await invoke<PatchPlanApplyResult>("plan_submission_retry", { preparationId: checkedPlan.preparationId })
        : await invoke<PatchPlanApplyResult>("patch_plan_apply_confirmed", {
            planPath: checkedPlan.planPath,
            approvedPlanSha256: checkedPlan.planSha256,
            runId: checkedPlan.runId,
          });
      const applied: PendingPatchPlan = {
        ...checkedPlan,
        tracePath: result.tracePath,
        status: "applied",
        changedFiles: result.report.changedFiles,
        receiptPath: result.report.receiptRecord,
        summaryItems: result.review?.userSummary?.items ?? checkedPlan.summaryItems,
        verificationLevel: result.review?.userSummary?.verificationLevel ?? "applied-to-source",
        verificationLabel:
          result.review?.userSummary?.verificationLabel
          ?? "已写入 Game A 并生成回执；尚未启动游戏，未完成试玩验证。",
        runtimeVerified: result.review?.userSummary?.runtimeVerified ?? false,
      };
      setProjectRevision((revision) => revision + 1);
      try {
        rememberPlan(applied);
      } catch {
        setPendingPlan({ ...applied, error: "修改已应用，但本地界面状态保存失败；请保留回执信息。" });
      }
    } catch (error) {
      if (checkedPlan.preparationId) {
        // A lost IPC reply is not evidence that the durable job failed.
        rememberPlan({ ...checkedPlan, status: "applying", error: undefined });
        setSessionError(`未收到可靠的提交结果，正在向后端核对：${String(error)}`);
      } else {
        rememberPlan({ ...checkedPlan, status: "error", error: String(error) });
      }
    } finally {
      applyingRef.current = false;
      await refreshSubmissions();
    }
  }, [rememberPlan, refreshSubmissions, backendStatusKnown]);

  async function sendMessage(resumeTask?: AgentTask, answer?: string) {
    const sameSessionFollowUp = task?.status === "ended"
      && (task.deliveryOutcome === "partial" || task.deliveryOutcome === "unresolved")
      && task.modelSessionId === agentSessionRef.current;
    const continuingTask = resumeTask ?? (task?.status === "awaiting_confirmation"
      || sameSessionFollowUp ? task : undefined);
    const content = answer ?? (continuingTask?.status === "awaiting_confirmation" ? draft.trim()
      : resumeTask ? "继续上次未完成的修改" : draft.trim());
    if (!content || busyRef.current || !backendStatusKnown || sessionInitializing || sessionReading || !agentReady) return;
    busyRef.current = true;
    observationEpochRef.current += 1;
    recoveredRunRef.current = null;
    const messageId = Date.now();
    const responseId = messageId + 1;

    setMessages((current) => [
      ...current,
      { id: messageId, role: "user", text: content },
      {
        id: responseId,
        role: "assistant",
        text: "",
        status: "thinking",
        thinkingHint: pickThinkingHint(),
      },
    ]);
    setDraft("");
    setIsThinking(true);
    agentRunRef.current = null;
    usageTurnStartedRef.current = false;

    if (!isTauri()) {
      setMessages((current) =>
        current.map((message) =>
          message.id === responseId
            ? {
                ...message,
                text: "真实 Agent 仅在 CoopAgent 桌面版中运行；浏览器预览不会执行 OpenCode。",
                status: undefined,
              }
            : message,
        ),
      );
      setIsThinking(false);
      busyRef.current = false;
      return;
    }

    const channel = new Channel<AgentEvent>();
    let checkedPlanForRun: PendingPatchPlan | null = null;
    agentChannelRef.current = channel;
    channel.onmessage = (event) => {
      if (!valid()) return;
      if (event.type === "scoped") {
        if (event.projectId !== project?.projectId || event.contextGeneration !== project.contextGeneration) return;
        event = event.event;
      }
      if (agentChannelRef.current !== channel) return;
      if (event.type === "started") {
        observationEpochRef.current += 1;
        setAgentRunning(true);
        setIsCancelling(false);
        agentRunRef.current = { runId: event.runId, tracePath: event.tracePath };
        return;
      }
      if (event.type === "activity") {
        setMessages((current) =>
          current.map((message) =>
            message.id === responseId ? { ...message, thinkingHint: event.label } : message,
          ),
        );
        return;
      }
      if (event.type === "usage") {
        if (event.sessionId && event.sessionId !== agentSessionRef.current) {
          rememberSession(event.sessionId);
        }
        setSessionUsage((current) => ({
          lastTurn: usageTurnStartedRef.current
            ? addTokenUsage(current.lastTurn, event.tokens)
            : { ...event.tokens },
          total: addTokenUsage(current.total, event.tokens),
        }));
        usageTurnStartedRef.current = true;
        return;
      }
      if (event.type === "phase") {
        setTask(event.task);
        const reply = event.task.checkpoint;
        if (reply?.disposition === "deliver" && reply.summary.trim()) {
          setMessages((current) => current.map((message) => message.id === responseId
            ? { ...message, text: reply.summary, status: undefined } : message));
        }
        return;
      }
      if (event.type === "paused") {
        observationEpochRef.current += 1;
        setTask(event.task); setAgentRunning(false); setIsCancelling(false);
        if (event.sessionId) rememberSession(event.sessionId);
        setMessages((current) => current.map((message) => message.id === responseId
          ? { ...message, text: event.task.lastCheckpoint?.summary ?? "进度已保存，可继续此任务。", status: undefined } : message));
        agentChannelRef.current = null;
        void refreshSubmissions(); void refreshAgentSessions();
        return;
      }
      if (event.type === "submissionChanged") {
        void refreshSubmissions();
        return;
      }
      if (event.type === "text") {
        setMessages((current) =>
          current.map((message) =>
            message.id === responseId
              ? { ...message, text: `${message.text}${event.text}`, status: undefined }
              : message,
          ),
        );
        return;
      }
      if (event.type === "planReady") {
        checkedPlanForRun = {
          runId: event.runId,
          tracePath: agentRunRef.current?.tracePath,
          planPath: event.planPath,
          planSha256: event.planSha256,
          planId: event.planId,
          operationCount: event.operationCount,
          changedFiles: event.changedFiles,
          summaryItems: event.summaryItems,
          verificationLevel: event.verificationLevel,
          verificationLabel: event.verificationLabel,
          runtimeVerified: event.runtimeVerified,
          status: "checked",
        };
        try { rememberPlan(checkedPlanForRun); } catch (error) {
          setPendingPlan({ ...checkedPlanForRun, status: "error", error: String(error) });
          checkedPlanForRun = null;
          return;
        }
        return;
      }
      if (event.type === "complete") {
        observationEpochRef.current += 1;
        setAgentRunning(false);
        setIsCancelling(false);
        if (event.sessionId) {
          rememberSession(event.sessionId);
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === responseId && !message.text
              ? { ...message, text: "Agent 已完成分析，但没有返回文本。", status: undefined }
              : message,
          ),
        );
        agentChannelRef.current = null;
        void refreshAgentSessions();
        // Completing a conversation never selects a prepared/checked plan.
        void refreshSubmissions();
        return;
      }
      if (event.type === "error" || event.type === "cancelled") {
        observationEpochRef.current += 1;
        setAgentRunning(false);
        setIsCancelling(false);
        if (event.sessionId) {
          rememberSession(event.sessionId);
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === responseId
              ? { ...message, text: event.type === "cancelled" ? event.message : `Agent 运行失败：${event.message}`, status: undefined }
              : message,
          ),
        );
        agentChannelRef.current = null;
        void refreshSubmissions();
        void refreshAgentSessions();
      }
    };

    try {
      await invoke("agent_start", {
        prompt: content,
        sessionId: agentSessionRef.current,
        taskId: continuingTask?.id ?? null,
        onEvent: channel,
      });
    } catch (error) {
      observationEpochRef.current += 1;
      setAgentRunning(false);
      setIsCancelling(false);
      setMessages((current) =>
        current.map((message) =>
          message.id === responseId
            ? { ...message, text: `无法启动 Agent：${String(error)}`, status: undefined }
            : message,
        ),
      );
      agentChannelRef.current = null;
      void refreshSubmissions();
      void refreshAgentSessions();
    }
  }

  async function applyPendingPlan() {
    if (pendingPlan) await applyCheckedPlan(pendingPlan);
  }

  async function cancelAgent() {
    const run = agentRunRef.current;
    if (!run || !agentRunning || isCancelling) return;
    setIsCancelling(true);
    try {
      await invoke("agent_cancel", { runId: run.runId });
      // Keep busy until the process end event and authoritative job observation.
    } catch (error) {
      setSessionError(String(error));
      setIsCancelling(false);
    }
  }

  const hasChangePlan = useMemo(
    () => messages.some((message) => message.role === "user"),
    [messages],
  );
  const activeSessionTitle = useMemo(
    () => activeSessionId
      ? agentSessions.find((session) => session.id === activeSessionId)?.title ?? "已连接 Session"
      : "新 Session",
    [activeSessionId, agentSessions],
  );

  return {
    activeSessionId,
    activeSessionTitle,
    agentSessions,
    agentRunning,
    task,
    resumeTask: () => task && sendMessage(task),
    confirmTarget: () => task?.status === "awaiting_confirmation" && sendMessage(task, "是，按上述目标和效果修改。"),
    cancelAgent,
    isCancelling,
    applyPendingPlan,
    beginNewAgentSession,
    conversationResetToken,
    deleteAgentSession,
    draft,
    hasChangePlan,
    isApplying,
    isThinking,
    messages,
    pendingPlan,
    projectRevision,
    readAgentSession,
    refreshAgentSessions,
    sendMessage,
    sessionDeletingId,
    sessionError,
    sessionInitializing: sessionInitializing || !backendStatusKnown,
    sessionReading,
    sessionUsage,
    sessionsLoading,
    setDraft,
  };
}

export type AgentController = ReturnType<typeof useAgentController>;
