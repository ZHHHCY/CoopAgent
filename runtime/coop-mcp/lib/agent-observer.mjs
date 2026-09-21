import { writeSync } from "node:fs";

export const OBSERVATION_PREFIX = "COOPAGENT_OBSERVATION ";
const bounded = (value) => {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text.length <= 32768 ? value : { truncated: true, originalChars: text.length, preview: text.slice(0, 32768) };
};
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Observe before execution, independently of `run --format json`, which can
// withhold tool_use until completion. No model text, reasoning, auth or headers.
export function createAgentObserver({ runId = process.env.COOPAGENT_RUN_ID,
  write = (line) => writeSync(2, line), now = Date.now } = {}) {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId ?? "")) return {};
  const emit = (event) => {
    try { write(OBSERVATION_PREFIX + JSON.stringify({ ...event, runId, observedAtMs: now() }) + "\n"); }
    catch { /* Observability must never fail a tool or change its result. */ }
  };
  emit({ type: "observer_ready", version: 1 });
  return {
    "tool.execute.before": async (input, output) => {
      emit({ type: "tool_use", sessionID: input.sessionID, part: {
        callID: input.callID, tool: input.tool,
        state: { status: "running", input: bounded(output.args), time: { start: now() } },
      } });
    },
    event: async ({ event }) => {
      if (event.type !== "message.part.updated") return;
      const p = event.properties?.part;
      if (!p) return;
      const ids = { id: p.id, messageID: p.messageID, sessionID: p.sessionID };
      if (p.type === "tool" && ["running", "completed", "error"].includes(p.state?.status)) {
        const s = p.state;
        emit({ type: "tool_use", sessionID: p.sessionID, part: { ...ids, callID: p.callID, tool: p.tool,
          state: { status: s.status, input: bounded(s.input), output: bounded(s.output),
            error: bounded(s.error), time: { start: s.time?.start, end: s.time?.end } } } });
      } else if (p.type === "step-start") {
        emit({ type: "step_start", sessionID: p.sessionID, part: ids });
      } else if (p.type === "step-finish") {
        const t = p.tokens ?? {};
        emit({ type: "step_finish", sessionID: p.sessionID, part: { ...ids, tokens: {
          input: count(t.input), output: count(t.output), reasoning: count(t.reasoning), total: count(t.total),
          cache: { read: count(t.cache?.read), write: count(t.cache?.write) },
        } } });
      }
    },
  };
}
