import assert from "node:assert/strict";
import test from "node:test";
import { createAgentObserver, OBSERVATION_PREFIX } from "../lib/agent-observer.mjs";

test("observer captures unfinished tool input before execution and only whitelisted usage metadata", async () => {
  const lines = [];
  const hooks = createAgentObserver({ runId: "run-test-1", write: (line) => lines.push(line), now: () => 123 });
  await hooks["tool.execute.before"]({ tool: "coop_plan_prepare", sessionID: "s1", callID: "c1" }, { args: { plan: { id: "p1" } } });
  assert.equal(lines.length, 2); // no completion is required to see the plan
  await hooks.event({ event: { type: "message.part.updated", properties: { part: {
    type: "reasoning", text: "HIDDEN_REASONING", sessionID: "s1" } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: {
    type: "step-finish", sessionID: "s1", id: "p2", messageID: "m1", text: "SECRET",
    tokens: { input: 12, output: 4, reasoning: 9, total: 125, cache: { read: 100, write: 0 } },
  } } } });
  const events = lines.map((s) => JSON.parse(s.slice(OBSERVATION_PREFIX.length)));
  assert.equal(events[1].part.state.input.plan.id, "p1");
  assert.equal(events[1].part.state.status, "running");
  assert.equal(events[2].part.tokens.total, 125);
  assert.doesNotMatch(lines.join(""), /HIDDEN_REASONING|SECRET/);
});

test("observer is opt-in, bounded, and cannot turn a logging failure into a tool failure", async () => {
  assert.deepEqual(createAgentObserver({ runId: "", write: () => assert.fail() }), {});
  const events = [];
  const hooks = createAgentObserver({ runId: "run-test", write: (s) => events.push(JSON.parse(s.slice(OBSERVATION_PREFIX.length))) });
  await hooks["tool.execute.before"]({ tool: "x", callID: "c" }, { args: { source: "x".repeat(40000) } });
  assert.equal(events[1].part.state.input.truncated, true);
  const broken = createAgentObserver({ runId: "run-test", write: () => { throw Error("closed"); } });
  await assert.doesNotReject(broken["tool.execute.before"]({ tool: "x" }, { args: {} }));
});
