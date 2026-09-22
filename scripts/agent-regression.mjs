#!/usr/bin/env node
// Opt-in, paid-model regression runner. All edits land in a marked local copy.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createCoopSearch } from "../runtime/coop-mcp/lib/coop-search.mjs";
import { createPlanSubmissionService } from "./lib/plan-submission.mjs";
import { treeHash } from "./lib/patch-plan-executor.mjs";
import { blindFixtureFile, blindModelConfig } from "./lib/blind-fixture.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(source, ".tools/agent-regressions");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const corePath = (root) => path.join(root, "game-a/core/GameA.SC2Mod");
const query = (root, databaseFile, objectId, field) => createCoopSearch({ repoRoot: root, databaseFile }).execute({
  operation: "entity.get", commanderId: "ProtossArtanis", catalog: "Unit", objectId, path: field,
});

async function initialize({ blind = false } = {}) {
  await mkdir(base, { recursive: true });
  const parent = await mkdtemp(path.join(base, "run-"));
  const root = path.join(parent, "project");
  const originalCoreHash = await treeHash(corePath(source));
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source, encoding: "utf8" });
  if (listing.status !== 0) throw Error(listing.stderr);
  for (const name of new Set(listing.stdout.split("\0").filter(Boolean))) {
    if (blind && !blindFixtureFile(name)) continue;
    if (!/^(AGENTS\.md|opencode\.json|package\.json|\.gitignore|docs\/|scripts\/|runtime\/|\.opencode\/|game-a\/)/.test(name)) continue;
    if (/^game-a\/(build|runtime|drafts|maps)\//.test(name)) continue;
    if (!existsSync(path.join(source, name))) continue;
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await cp(path.join(source, name), path.join(root, name));
  }
  if (blind) {
    await save(path.join(root, 'opencode.json'), blindModelConfig(await json(path.join(root, 'opencode.json')), root));
    // Stop OpenCode's parent-project/skill discovery at this fixture, not the
    // source repository containing prior attempts and human reference answers.
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    if (initialized.status !== 0) throw Error(initialized.stderr);
  }
  for (const folder of ["node_modules", "runtime/coop-mcp/node_modules", ".tools/node", ".tools/opencode"]) {
    await mkdir(path.dirname(path.join(root, folder)), { recursive: true });
    await symlink(path.join(source, folder), path.join(root, folder), process.platform === "win32" ? "junction" : "dir");
  }
  const { databaseFile } = createCoopSearch({ repoRoot: source }).locateDatabase();
  const catalogRoot = path.join(path.dirname(databaseFile), "merged/GameData");
  const baseline = await json(path.join(root, "game-a/runtime-baseline.json"));
  if (!blind) {
  const edits = ["LifeMax", "LifeStart"].map((field) => query(root, databaseFile, "Dragoon", field).editState.edit);
  assert.ok(edits.every((edit) => edit.available));
  // Fixed test initial state only, before any model task. Preserve all unrelated
  // user content; subsequent tasks must read/modify the prior model's result.
  const plan = { formatVersion: 2, id: "regression-dragoon-initial-state", title: "Regression initial state",
    userSummary: { text: "回归测试初态：龙骑士生命恢复为 100。" }, target: "game-a.core",
    compatibility: { sc2DataBuild: baseline.sc2.dataBuild, runtimeContract: baseline.schemaVersion },
    scope: { kind: "commander", commanderId: "ProtossArtanis" }, isolation: { strategy: "player-upgrade" },
    dependsOn: [...new Set(edits.flatMap((edit) => edit.requiredDependsOn))],
    operations: edits.map((edit, i) => ({ opId: `initial-life-${i}`, ...edit.operation, expect: edit.expect, value: 100 })) };
  const service = createPlanSubmissionService({ repoRoot: root });
  const prepared = await service.prepare({ planContent: plan, planPath: "game-a/drafts/regression-dragoon-initial-state.patch-plan.json",
    catalogRoot, databaseFile, runId: "regression-fixture-setup" });
  await service.submit({ preparationId: prepared.preparationId });
  }
  await save(path.join(parent, "fixture.json"), { version: 1, root, source, databaseFile, catalogRoot,
    originalCoreHash, initialCoreHash: await treeHash(corePath(root)), createdAt: new Date().toISOString(),
    isolation: blind ? { mode: 'blind', priorPlansCopied: false, referencesCopied: false, externalDirectory: 'deny', gitBoundary: true } : { mode: 'current-project' } });
  assert.equal(await treeHash(corePath(source)), originalCoreHash, "Original Map Runtime changed during fixture setup");
  console.log(JSON.stringify({ root, fixture: path.join(parent, "fixture.json") }));
}

const scenarios = {
  first: { prompt: "把阿塔尼斯的龙骑士生命值设置为300，出生时也满血。", object: "Dragoon", value: 300 },
  second: { prompt: "把阿塔尼斯的龙骑士生命值改成200，出生时也满血。", object: "Dragoon", value: 200 },
  clone: { prompt: "把阿塔尼斯已有的本地克隆风暴战舰 GameAExampleArtanisTempest 的生命值改为600，出生时也满血。不要修改原版风暴战舰。", object: "GameAExampleArtanisTempest", value: 600 },
  retry: { prompt: "把阿塔尼斯的龙骑士生命值改成250，出生时也满血。", object: "Dragoon", value: 250 },
};

async function run(root, scenarioName) {
  root = path.resolve(root ?? "");
  if (!root.startsWith(`${base}${path.sep}`) || root === source) throw Error("Run requires a marked isolated regression project");
  const parent = path.dirname(root), fixture = await json(path.join(parent, "fixture.json"));
  assert.equal(fixture.root, root);
  const scenario = scenarios[scenarioName];
  if (!scenario) throw Error(`Unknown scenario; choose ${Object.keys(scenarios)}`);
  const configPath = path.join(process.env.APPDATA, "CoopAgent/opencode-models.json");
  const config = await json(configPath);
  if (!config.model) throw Error("Configure and select a model in CoopAgent first");
  const runId = `regression-${scenarioName}-${Date.now()}`;
  const logPath = path.join(parent, `${runId}.jsonl`);
  const service = createPlanSubmissionService({ repoRoot: root });
  const before = ["LifeMax", "LifeStart"].map((field) => query(root, fixture.databaseFile, scenario.object, field));
  const originalBefore = await treeHash(corePath(source));
  const started = Date.now();
  const executable = path.join(source, ".tools/opencode/bin/opencode.exe");
  const environment = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    OPENCODE_CONFIG: configPath, COOPAGENT_RUN_ID: runId,
    COOPAGENT_CATALOG_ROOT: fixture.catalogRoot, COOPAGENT_DATABASE: fixture.databaseFile };
  let lockChild = null;
  if (scenarioName === "retry") {
    const target = path.join(corePath(root), "Base.SC2Data/GameData/UpgradeData.xml");
    const script = '$stream=[IO.File]::Open($env:COOP_REGRESSION_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $stream.Dispose()';
    lockChild = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true,
      env: { ...environment, COOP_REGRESSION_LOCK: target }, stdio: ["pipe", "pipe", "pipe"] });
    await once(lockChild.stdout, "data");
  }
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(executable, ["run", "--agent", "coop-planner", "--format", "json", "--thinking", "--model", config.model, scenario.prompt],
    { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let sessionId = null, finalText = "", inputTokens = 0, outputTokens = 0, reportedCost = 0;
  const calls = [], errors = [];
  const lines = createInterface({ input: child.stdout });
  const outputDone = once(lines, "close");
  lines.on("line", (line) => {
    log.write(`${line}\n`);
    try {
      const event = JSON.parse(line), part = event.part ?? {};
      sessionId ??= event.sessionID ?? part.sessionID ?? null;
      if (event.type === "text") finalText += part.text ?? "";
      if (event.type === "tool_use") {
        calls.push({ tool: part.tool, status: part.state?.status, input: part.state?.input, error: part.state?.error });
        console.log(JSON.stringify({ runId, tool: part.tool, status: part.state?.status, elapsedSeconds: Math.round((Date.now()-started)/1000) }));
      }
      if (event.type === "step_finish") {
        inputTokens += part.tokens?.input ?? 0; outputTokens += part.tokens?.output ?? 0; reportedCost += part.cost ?? 0;
      }
      if (event.type === "error") errors.push(event.error);
    } catch { /* Non-JSON provider diagnostics stay in the raw log. */ }
  });
  child.stderr.on("data", (chunk) => log.write(`${JSON.stringify({ stderr: chunk.toString() })}\n`));
  console.log(JSON.stringify({ runId, pid: child.pid, root, model: config.model, logPath }));
  let injectionObserved = false, cancellationStarted = false;
  const monitor = setInterval(() => {
    const jobs = service.status().filter((job) => job.runId === runId);
    if (lockChild && jobs.some((job) => job.state === "failed")) {
      injectionObserved = true; lockChild.stdin.end("\n"); lockChild = null;
    }
    if (!cancellationStarted && Date.now()-started > 15*60*1000) {
      cancellationStarted = true;
      service.cancelRun(runId);
      child.kill();
    }
  }, 300);
  const [exitCode, signal] = await once(child, "exit");
  clearInterval(monitor);
  if (lockChild) lockChild.stdin.end("\n");
  await outputDone;
  log.end(); await once(log, "finish");
  const jobs = service.status().filter((job) => job.runId === runId);
  const pending = jobs.some((job) => ["submitted", "applying"].includes(job.state));
  const after = pending ? [] : ["LifeMax", "LifeStart"].map((field) => query(root, fixture.databaseFile, scenario.object, field));
  const originalUnchanged = await treeHash(corePath(source)) === originalBefore;
  const appliedPlans = await Promise.all(jobs.filter((job) => job.state === "applied")
    .map((job) => json(path.join(root, "game-a/patches", `${job.prepared.planId}.patch-plan.json`))));
  const requiredDependencies = new Set(before.flatMap((field) => field.editState.edit.requiredDependsOn));
  const scopeAndOperationsMatch = appliedPlans.length === 1 && appliedPlans.every((plan) =>
    plan.scope?.kind === "commander" && plan.scope.commanderId === "ProtossArtanis" &&
    plan.isolation?.strategy === "player-upgrade" && plan.operations.length === 2 &&
    new Set(plan.operations.map((op) => op.path)).size === 2 && plan.operations.every((op) =>
      op.kind === "commander.stat.set" && op.commanderId === "ProtossArtanis" && op.catalog === "Unit" &&
      op.object === scenario.object && ["LifeMax", "LifeStart"].includes(op.path) && op.value === scenario.value) &&
    [...requiredDependencies].every((id) => plan.dependsOn?.includes(id)));
  const submissions = calls.filter((call) => call.tool === "coop_plan_submit");
  const sameTokenRetry = scenarioName !== "retry" || (submissions.some((call) => call.status === "error") &&
    submissions.some((call) => call.status === "completed") && new Set(submissions.map((call) => call.input?.preparationId)).size === 1);
  const result = { runId, scenario: scenarioName, prompt: scenario.prompt, root, model: config.model,
    sessionId, exitCode, signal, elapsedSeconds: (Date.now()-started)/1000,
    inputTokens, outputTokens, reportedCost, callCount: calls.length, calls, errors, finalText,
    before, after, injectionObserved, jobs: jobs.map((job) => ({ state: job.state, preparationId: job.preparationId,
      planId: job.prepared.planId, error: job.error, receipt: job.result?.report.receiptRecord })),
    originalUnchanged, scopeAndOperationsMatch, sameTokenRetry, pending,
    passed: !pending && jobs.some((job) => job.state === "applied") && originalUnchanged && scopeAndOperationsMatch && sameTokenRetry &&
      after.every((field) => field.editState.edit.expect === scenario.value) && (scenarioName !== "retry" || injectionObserved) };
  await save(path.join(parent, `${runId}.result.json`), result);
  console.log(JSON.stringify({ runId, passed: result.passed, pending, exitCode, elapsedSeconds: result.elapsedSeconds,
    callCount: result.callCount, resultPath: path.join(parent, `${runId}.result.json`), finalText }));
  if (!result.passed) process.exitCode = 1;
}

const [operation, root, scenario] = process.argv.slice(2);
if (operation === "init") await initialize({ blind: root === '--blind' });
else if (operation === "run") await run(root, scenario);
else throw Error("Usage: agent-regression.mjs init | run <isolated-project> first|second|clone|retry");
