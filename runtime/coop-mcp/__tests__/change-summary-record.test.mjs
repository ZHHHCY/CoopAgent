import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPlanSummaryRecord,
  parseHistoricalSummaryIndex,
  resolvePlanSummaryText,
} from "../lib/change-summary-record.mjs";

test("every applied PatchPlan has an embedded summary or historical fallback", async (t) => {
  const patchesRoot = await mkdtemp(path.join(os.tmpdir(), "coopagent-summary-records-"));
  t.after(() => rm(patchesRoot, { recursive: true, force: true }));
  await mkdir(patchesRoot, { recursive: true });
  await writeFile(path.join(patchesRoot, "embedded.patch-plan.json"), JSON.stringify({
    id: "embedded",
    userSummary: { text: "将测试单位生命值调整为 100。" },
  }), "utf8");
  await writeFile(path.join(patchesRoot, "historical.patch-plan.json"), JSON.stringify({
    id: "historical",
  }), "utf8");
  await writeFile(path.join(patchesRoot, "user-summaries.json"), JSON.stringify({
    formatVersion: 1,
    summaries: [{ planId: "historical", text: "调整历史测试项目。" }],
  }), "utf8");

  const document = JSON.parse(await readFile(path.join(patchesRoot, "user-summaries.json"), "utf8"));
  const summaries = parseHistoricalSummaryIndex(document);
  const planIds = (await readdir(patchesRoot))
    .filter((name) => name.endsWith(".patch-plan.json"))
    .map((name) => name.slice(0, -".patch-plan.json".length))
    .sort();

  for (const id of planIds) {
    const plan = JSON.parse(await readFile(path.join(patchesRoot, `${id}.patch-plan.json`), 'utf8'));
    assert.ok(plan.userSummary?.text?.trim() || summaries.has(id), `Missing summary: ${id}`);
  }
  for (const id of summaries.keys()) assert.ok(planIds.includes(id), `Orphan historical summary: ${id}`);
});

test("one plan becomes one user record while preserving all target associations", () => {
  const historicalSummaries = new Map([["hero-plan", "为阿塔尼斯新增英雄单位。"]]);
  const result = buildPlanSummaryRecord({
    plan: {
      id: "hero-plan",
      title: "Hero implementation details",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
    },
    receipt: {
      operations: [
        { opId: "create-unit", status: "changed", verified: true },
        { opId: "set-model", status: "already", verified: true },
      ],
    },
    changeItems: [
      {
        opIds: ["create-unit"],
        catalogTargets: [{ catalog: "Unit", objectId: "GameAArtanisHero", path: null }],
      },
      {
        opIds: ["set-model"],
        catalogTargets: [{ catalog: "Actor", objectId: "GameAArtanisHero", path: "Model" }],
      },
    ],
    historicalSummaries,
  });

  assert.equal(result.item.text, "为阿塔尼斯新增英雄单位。");
  assert.equal(result.item.kind, "patch-plan");
  assert.equal(result.item.commanderId, "ProtossArtanis");
  assert.deepEqual(result.item.opIds, ["create-unit", "set-model"]);
  assert.deepEqual(result.scopeUnitIds, ["GameAArtanisHero"]);
  assert.equal(result.item.status, "changed");
  assert.equal(result.item.verified, true);
});

test("embedded summaries override historical compatibility text", () => {
  assert.equal(resolvePlanSummaryText({
    id: "new-plan",
    title: "Internal title",
    userSummary: { text: "调整雷诺维京的生命值 125 → 150。" },
  }, new Map([["new-plan", "旧摘要"]])), "调整雷诺维京的生命值 125 → 150。");
});

test("historical summary index rejects duplicate and multiline records", () => {
  assert.throws(() => parseHistoricalSummaryIndex({
    formatVersion: 1,
    summaries: [
      { planId: "same-plan", text: "第一条摘要。" },
      { planId: "same-plan", text: "第二条摘要。" },
    ],
  }), /duplicated/);
  assert.throws(() => parseHistoricalSummaryIndex({
    formatVersion: 1,
    summaries: [{ planId: "multiline-plan", text: "第一行\n第二行" }],
  }), /one 4–160 character line/);
});
