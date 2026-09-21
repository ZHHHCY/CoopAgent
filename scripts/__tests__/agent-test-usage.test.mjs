import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRunUsage, summarizeUsage } from "../agent-test-usage.mjs";

const completed = (tokens) => ({ role: "assistant", tokens, time: { completed: 20 } });
const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 20, write: 0 }, total: 35 };

test("input, cache and reasoning remain separate; each message counted once", () => {
  const s = summarizeUsage([{ role: "user" }, completed(tokens), completed(tokens)]);
  assert.equal(s.requestCount, 2);
  assert.equal(s.coverage, "recorded-complete");
  assert.deepEqual(s.recordedTotals, { input: 20, cacheRead: 40, cacheWrite: 0, output: 6, reasoning: 4, total: 70 });
  assert.ok(s.requests.every((r) => r.componentsReconcile));
});

test("interrupted zero placeholder is unknown, not a free completed request", () => {
  const s = summarizeUsage([completed(tokens), { role: "assistant", tokens: {
    input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]);
  assert.equal(s.coverage, "partial");
  assert.equal(s.requestsWithoutUsage, 1);
  assert.equal(s.incompleteRequests, 1);
  assert.equal(s.requests[1].tokens.total, null);
  assert.equal(s.recordedTotals.total, 35);
});

test("missing fields are not synthesized as zero", () => {
  const s = summarizeUsage([completed({ input: 10, output: 3 })]);
  assert.equal(s.coverage, "partial");
  assert.equal(s.recordedTotals.total, null);
  assert.equal(s.recordedTotals.reasoning, null);
});

test("provider total wins; mismatched component accounting is visible", () => {
  const s = summarizeUsage([completed({ ...tokens, total: 33 })]);
  assert.equal(s.recordedTotals.total, 33);
  assert.equal(s.requests[0].componentsReconcile, false);
});

test("derive a total only when all components are reported", () => {
  const { total, ...components } = tokens;
  const s = summarizeUsage([completed(components)]);
  assert.equal(s.recordedTotals.total, total);
  assert.equal(s.requests[0].totalSource, "component-sum");
});

test("empty accounting does not claim zero usage", () => {
  const s = summarizeUsage([]);
  assert.equal(s.coverage, "partial");
  assert.equal(s.recordedTotals.total, null);
});

test("read-only run query excludes earlier/later requests and other sessions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coop-usage-test-"));
  const database = path.join(dir, "fixture.sqlite");
  const trace = path.join(dir, "trace.jsonl");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)");
  for (const [id, session, at] of [["earlier", "ses-1", 5], ["included", "ses-1", 15],
    ["later", "ses-1", 25], ["other", "ses-2", 15]]) {
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(id, session, at,
      JSON.stringify({ ...completed(tokens), text: "MUST_NOT_EXPORT" }));
  }
  db.close();
  writeFileSync(trace, [
    { runId: "run-1", event: "run.created", timestampMs: 10 },
    { runId: "run-1", event: "agent.session.discovered", timestampMs: 11, details: { sessionId: "ses-1" } },
    { runId: "run-1", event: "run.cancelled", timestampMs: 20 },
  ].map(JSON.stringify).join("\n"));
  const s = readRunUsage(trace, database);
  assert.equal(s.requestCount, 1);
  assert.equal(s.requests[0].messageId, "included");
  assert.equal(s.recordedTotals.total, 35);
  assert.ok(!JSON.stringify(s).includes("MUST_NOT_EXPORT"));
});

test("new traces account per step without OpenCode DB and keep an unfinished request unknown", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coop-trace-usage-"));
  const trace = path.join(dir, "trace.jsonl");
  const events = [
    { event: "run.created" },
    { event: "agent.session.discovered", details: { sessionId: "ses-1" } },
    { event: "agent.observer.ready" },
    { event: "agent.step.started", details: { messageId: "m1", partId: "start-1" } },
    { event: "agent.usage", details: { messageId: "m1", partId: "finish-1", tokens } },
    { event: "agent.usage", details: { messageId: "m1", partId: "finish-1", tokens } },
    { event: "agent.step.started", details: { messageId: "m2", partId: "start-2" } },
    { event: "run.cancelled" },
  ];
  writeFileSync(trace, events.map((e, i) => JSON.stringify({ ...e, runId: "run-1", timestampMs: i + 1 })).join("\n"));
  const result = readRunUsage(trace, path.join(dir, "does-not-exist.db"));
  assert.equal(result.source, "coopagent-trace-usage");
  assert.equal(result.requestCount, 2);
  assert.equal(result.requestsWithoutUsage, 1);
  assert.equal(result.recordedTotals.total, 35);
  assert.equal(result.requests[1].tokens.total, null);
  assert.equal(result.coverage, "partial");
});

test("staged runs aggregate fresh sessions and report usage for each phase; cut-off usage stays partial", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coop-phase-usage-"));
  const trace = path.join(dir, "trace.jsonl");
  const events = [{ event: "run.created" }, ...[1, 2].flatMap((phase) => [
    { event: "task.phase.started", details: { phase } },
    { event: "agent.session.discovered", details: { sessionId: `s${phase}` } },
    { event: "agent.usage", details: { sessionId: `s${phase}`, messageId: "same-id", partId: "same-part", tokens } },
    { event: "task.phase.ended", details: { task: { phase, status: "ready" }, budgetExpired: phase === 1 } },
  ]), { event: "run.paused" }];
  writeFileSync(trace, events.map((e, i) => JSON.stringify({ ...e, runId: "run-1", timestampMs: i + 1 })).join("\n"));
  const result = readRunUsage(trace);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.sessionIds, ['s1', 's2']);
  assert.equal(result.recordedTotals.total, 70);
  assert.equal(result.phases[0].recordedTotals.total, 35);
  assert.equal(result.phases[1].recordedTotals.total, 35);
  assert.equal(result.phases[0].coverage, "partial");
  assert.equal(result.coverage, "partial");
});

test('an orderly blocked checkpoint is not a cancelled or unreported provider request', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'coop-paused-usage-'));
  const trace = path.join(dir, 'trace.jsonl');
  const events = [
    { event: 'run.created' }, { event: 'task.phase.started', details: { phase: 1 } },
    { event: 'agent.session.discovered', details: { sessionId: 's1' } },
    { event: 'agent.usage', details: { sessionId: 's1', messageId: 'm1', tokens } },
    { event: 'task.phase.ended', details: { budgetExpired: false, task: { phase: 1, status: 'blocked', history: [{ reason: 'completed' }] } } },
    { event: 'run.paused' },
  ];
  writeFileSync(trace, events.map((e, i) => JSON.stringify({ ...e, runId: 'run-1', timestampMs: i + 1 })).join('\n'));
  const result = readRunUsage(trace);
  assert.equal(result.coverage, 'recorded-complete');
  assert.equal(result.recordedTotals.total, 35);
  assert.equal(result.note, undefined);
});
