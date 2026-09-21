import type { AgentRunSnapshot, Message } from "./types";

export function runIsActive(run: AgentRunSnapshot | null) {
  return run?.state === "starting" || run?.state === "running";
}

// Snapshots contain absolute text, not deltas: polling/reloading must never
// append an already displayed chunk or steal an unrelated historical session.
export function messagesFromSnapshot(messages: Message[], run: AgentRunSnapshot): Message[] {
  const userId = `run-${run.runId}-user`;
  const responseId = `run-${run.runId}-response`;
  const existing = messages.findIndex((message) => message.id === responseId);
  const text = run.error
    ? `${run.text}${run.text ? "\n\n" : ""}${run.error}`
    : run.text || (runIsActive(run) ? "" : "Agent 已完成分析，但没有返回文本。");
  const response: Message = {
    id: responseId, role: "assistant", text,
    status: runIsActive(run) && !text ? "thinking" : undefined,
    thinkingHint: run.activity,
  };
  if (existing >= 0) return messages.map((message, index) => index === existing ? response : message);
  const historyIndex = messages.findIndex((message) => message.role === "user"
    && message.text === run.prompt && (message.createdAtMs ?? 0) >= run.startedAtMs);
  const prefix = historyIndex >= 0 ? messages.slice(0, historyIndex) : messages;
  return [...prefix, { id: userId, role: "user", text: run.prompt, createdAtMs: run.startedAtMs }, response];
}
