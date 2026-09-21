#!/usr/bin/env node
// Fault/checkpoint fixture for native-window handoff tests, never a model tool.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { agentTestLaunchOptions } from "./lib/agent-test-client.mjs";

const [command, project, preparationId] = process.argv.slice(2);
try {
  if (!["prepare", "hold"].includes(command)) throw Error("Usage: agent-desktop-handoff.mjs prepare|hold <isolated project> [preparationId]");
  const { projectRoot } = await agentTestLaunchOptions(project);
  const fixture = JSON.parse(await readFile(path.join(projectRoot, "../fixture.json"), "utf8"));
  const { createPlanSubmissionService } = await import(pathToFileURL(path.join(projectRoot, "scripts/lib/plan-submission.mjs")));
  const service = createPlanSubmissionService({ repoRoot: projectRoot,
    ...(command === "hold" ? { transactionHooks: { afterInstall: async (_entry, index) => {
      if (index !== 0) return;
      // A real transaction now owns the project lock and recovery journal.
      // No success is reported until it is resumed and all files are committed.
      console.log(JSON.stringify({ checkpoint: "first-file-installed", preparationId, pid: process.pid }));
      const timeout = setTimeout(() => process.exit(43), 300000);
      try {
        const [input] = await once(process.stdin, "data");
        if (String(input).trim() !== "resume") throw Error("Expected resume at checkpoint");
      } finally { clearTimeout(timeout); process.stdin.pause(); }
    } } } : {}),
  });
  if (command === "prepare") {
    const { createCoopSearch } = await import(pathToFileURL(path.join(projectRoot, "runtime/coop-mcp/lib/coop-search.mjs")));
    const query = createCoopSearch({ repoRoot: projectRoot, databaseFile: fixture.databaseFile });
    const edits = ["LifeMax", "LifeStart"].map(field => query.execute({ operation: "entity.get",
      commanderId: "ProtossArtanis", catalog: "Unit", objectId: "Dragoon", path: field }).editState.edit);
    if (edits.some(edit => !edit.available)) throw Error("Expected editable test vitals");
    const value = edits.every(edit => edit.expect === 350) ? 360 : 350;
    const baseline = JSON.parse(await readFile(path.join(projectRoot, "game-a/runtime-baseline.json"), "utf8"));
    const id = `desktop-handoff-${Date.now()}`;
    const plan = { formatVersion: 2, id, title: "Desktop handoff regression", target: "game-a.core",
      userSummary: { text: `窗口交接回归：测试副本龙骑士生命设置为${value}。` },
      compatibility: { sc2DataBuild: baseline.sc2.dataBuild, runtimeContract: baseline.schemaVersion },
      scope: { kind: "commander", commanderId: "ProtossArtanis" }, isolation: { strategy: "player-upgrade" },
      dependsOn: [...new Set(edits.flatMap(edit => edit.requiredDependsOn))],
      operations: edits.map((edit, index) => ({ opId: `life-${index}`, ...edit.operation, expect: edit.expect, value })),
    };
    const prepared = await service.prepare({ planContent: plan, planPath: `game-a/drafts/${id}.patch-plan.json`,
      databaseFile: fixture.databaseFile, catalogRoot: fixture.catalogRoot, runId: id });
    console.log(JSON.stringify({ preparationId: prepared.preparationId, planId: id, projectRoot, value }));
  } else {
    const result = await service.submit({ preparationId });
    console.log(JSON.stringify({ state: result.status, receipt: result.report.receiptRecord }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
