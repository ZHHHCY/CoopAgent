#!/usr/bin/env node
// Read-only test accounting. Never reads message text, reasoning text or auth.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fields = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total"];

export function summarizeUsage(messages) {
  const requests = messages.filter((m) => m.role === "assistant").map((m, i) => {
    const t = m.tokens ?? {};
    const values = { input: count(t.input), cacheRead: count(t.cache?.read),
      cacheWrite: count(t.cache?.write), output: count(t.output), reasoning: count(t.reasoning) };
    const componentSum = Object.values(values).every((v) => v !== null)
      ? Object.values(values).reduce((a, b) => a + b, 0) : null;
    const completed = Number.isFinite(m.time?.completed);
    // OpenCode inserts an all-zero placeholder before the provider replies.
    const usageReported = count(t.total) !== null || Object.values(values).some((v) => v > 0)
      || (completed && componentSum !== null);
    const reportedTotal = count(t.total);
    const total = usageReported ? reportedTotal ?? componentSum : null;
    return { request: i + 1, messageId: m.id, startedAtMs: m.createdAtMs, phase: m.phase, sessionId: m.sessionId,
      model: m.modelID, provider: m.providerID, completed, usageReported,
      tokens: usageReported ? { ...values, total } : Object.fromEntries(fields.map((f) => [f, null])),
      totalSource: reportedTotal !== null ? "reported" : total !== null ? "component-sum" : "unavailable",
      componentsReconcile: reportedTotal !== null && componentSum !== null ? reportedTotal === componentSum : null };
  });
  const recordedTotals = Object.fromEntries(fields.map((f) => {
    const known = requests.map((r) => r.tokens[f]).filter((v) => v !== null);
    return [f, known.length ? known.reduce((a, b) => a + b, 0) : null];
  }));
  return { requestCount: requests.length, requestsWithUsage: requests.filter((r) => r.usageReported).length,
    requestsWithoutUsage: requests.filter((r) => !r.usageReported).length,
    incompleteRequests: requests.filter((r) => !r.completed).length,
    coverage: requests.length && requests.every((r) => r.completed && fields.every((f) => r.tokens[f] !== null))
      ? "recorded-complete" : "partial", recordedTotals, requests };
}

export function readRunUsage(tracePath, databasePath = path.join(homedir(), ".local/share/opencode/opencode.db")) {
  const events = readFileSync(tracePath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const sessionIds = [...new Set(events.filter((e) => e.event === "agent.session.discovered")
    .map((e) => e.details?.sessionId).filter(Boolean))];
  const phased = events.some((e) => e.event === "task.phase.started");
  if (sessionIds.length !== 1 && !phased) throw Error("Expected exactly one discovered session in the run trace");
  const runIds = new Set(events.map((e) => e.runId));
  if (runIds.size !== 1) throw Error("Trace contains multiple runs");
  const startMs = events[0].timestampMs;
  const terminal = events.findLast((e) => ["run.completed", "run.cancelled", "run.failed", "run.paused", "agent.completed"].includes(e.event));
  const endMs = terminal?.timestampMs ?? Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw Error("Invalid trace timestamps");
  // New runs are self-contained; old runs retain the read-only DB fallback.
  if (events.some((e) => ["agent.usage", "agent.observer.ready"].includes(e.event))) {
    const messages = new Map();
    const seenUsage = new Set();
    let phase = null;
    const model = events.find((e) => e.event === "request.received")?.details?.model;
    for (const e of events) {
      if (e.event === "task.phase.started") phase = e.details.phase;
      if (!["agent.step.started", "agent.usage"].includes(e.event)) continue;
      const d = e.details ?? {};
      const id = d.messageId ?? d.partId;
      if (!id) continue;
      const identity = `${d.sessionId ?? phase ?? ''}:${id}`;
      const m = messages.get(identity) ?? { id, phase, sessionId: d.sessionId, role: "assistant", createdAtMs: e.timestampMs, modelID: model };
      if (e.event === "agent.usage") {
        const key = `${d.sessionId ?? phase ?? ''}:${d.partId ?? id}`;
        if (seenUsage.has(key)) continue;
        seenUsage.add(key);
        m.tokens = d.tokens;
        m.time = { completed: e.timestampMs };
      }
      messages.set(identity, m);
    }
    const summary = summarizeUsage([...messages.values()]);
    const phases = events.filter((e) => e.event === "task.phase.started").map((e) => {
      const end = events.find((x) => x.event === "task.phase.ended" && x.details?.task?.phase === e.details.phase);
      const phaseUsage = summarizeUsage([...messages.values()].filter((m) => m.phase === e.details.phase));
      return { phase: e.details.phase, durationMs: end ? end.timestampMs - e.timestampMs : null,
        budgetExpired: end?.details?.budgetExpired ?? null, status: end?.details?.task?.status ?? "unknown",
        ...phaseUsage, coverage: !end || end.details.budgetExpired ? "partial" : phaseUsage.coverage };
    });
    const interrupted = !terminal || ['run.failed', 'run.cancelled'].includes(terminal.event)
      || phases.some((p) => p.budgetExpired || p.durationMs === null)
      || events.some((e) => e.event === 'task.phase.ended' && ['error', 'cancelled'].includes(e.details?.task?.history?.at(-1)?.reason));
    return { version: 2, runId: events[0].runId, sessionId: sessionIds[0], sessionIds, phases,
      source: "coopagent-trace-usage", window: { startMs, endMs, terminal: !!terminal },
      ...summary, coverage: interrupted ? "partial" : summary.coverage,
      note: interrupted ? "Recorded usage is a lower bound; the interrupted provider request may not have emitted step_start or usage." : undefined };
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // Do not use session cumulative counters: a resumed session may span runs.
    // Select only usage metadata, never export model text or hidden reasoning.
    const rows = db.prepare(`SELECT id,time_created AS createdAtMs,
      json_extract(data,'$.role') AS role,json_extract(data,'$.modelID') AS modelID,
      json_extract(data,'$.providerID') AS providerID,json_extract(data,'$.tokens') AS tokens,
      json_extract(data,'$.time') AS time FROM message
      WHERE session_id=? AND time_created>=? AND time_created<=? ORDER BY time_created,id`)
      .all(sessionIds[0], startMs, endMs)
      .map((r) => ({ ...r, tokens: r.tokens ? JSON.parse(r.tokens) : null, time: r.time ? JSON.parse(r.time) : null }));
    return { version: 1, runId: events[0].runId, sessionId: sessionIds[0],
      source: "opencode-local-message-usage", window: { startMs, endMs, terminal: !!terminal },
      ...summarizeUsage(rows) };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [trace, database, ...extra] = process.argv.slice(2);
    if (!trace || extra.length) throw Error("Usage: node scripts/agent-test-usage.mjs <trace.jsonl> [opencode.db]");
    console.log(JSON.stringify(readRunUsage(trace, database), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
