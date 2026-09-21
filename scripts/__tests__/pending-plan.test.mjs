import assert from "node:assert/strict";
import test from "node:test";
import { pendingFromSubmission, restorePendingPlan } from "../../src/features/agent/pending-plan.ts";

const plan = {
  runId: "run-123-456-1", planId: "example", planPath: "game-a/drafts/example.patch-plan.json",
  planSha256: "a".repeat(64), changedFiles: [], summaryItems: ["生命值改为 200"],
  status: "applying", runtimeVerified: false,
};

test("restored in-flight plans require an explicit retry with the original identity", () => {
  for (const status of ["checked", "applying"]) {
    const restored = restorePendingPlan(JSON.stringify({ ...plan, status }));
    assert.equal(restored.status, "error");
    assert.equal(restored.planSha256, plan.planSha256);
    assert.equal(restored.runId, plan.runId);
    assert.match(restored.error, /重试/);
  }
});

test("restoration preserves completed outcomes and rejects corrupt or unsafe pointers", () => {
  assert.equal(restorePendingPlan(JSON.stringify({ ...plan, status: "applied" })).status, "applied");
  for (const value of [null, "not json", "{}", JSON.stringify({ ...plan, planPath: "../other.json" }), JSON.stringify({ ...plan, summaryItems: [1] })]) {
    assert.equal(restorePendingPlan(value), null);
  }
});

test("backend state distinguishes accepted work from an applied receipt", () => {
  const prepared = { planPath: plan.planPath, planSha256: plan.planSha256,
    report: { id: plan.planId, operations: [{}], changedFiles: ["UnitData.xml"], receiptRecord: "receipt.json" },
    review: { userSummary: { items: plan.summaryItems } } };
  for (const state of ["submitted", "applying", "failed", "stale", "cancelled", "applied"]) {
    const view = pendingFromSubmission({ preparationId: `prep-${"a".repeat(48)}`, state,
      runId: plan.runId, prepared, result: state === "applied" ? prepared : null,
      error: state === "failed" ? { message: "locked" } : null });
    assert.equal(view.status, state === "applied" ? "applied" : ["submitted", "applying"].includes(state) ? "applying" : "error");
    assert.equal(view.receiptPath, state === "applied" ? "receipt.json" : undefined);
    assert.equal(view.runtimeVerified, false);
    assert.equal(view.preparationId, `prep-${"a".repeat(48)}`);
  }
});
