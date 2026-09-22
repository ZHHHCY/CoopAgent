import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPlanSubmissionService } from "../lib/plan-submission.mjs";
import { createAgentTaskStore } from "../lib/agent-task.mjs";
import { acquireGameALock } from "../lib/game-a-transaction.mjs";
import { buildCascDatabase } from "../lib/casc-database-builder.mjs";
import { createCoopAgentCore } from "../../runtime/coop-mcp/lib/coop-agent-core.mjs";
import { validatePrestigeContract } from '../lib/prestige-contract.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "coop-submit-test-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const put = async (file, data) => { await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), typeof data === "string" ? data : JSON.stringify(data)); };
  await cp(path.join(repository, "docs/schemas"), path.join(repoRoot, "docs/schemas"), { recursive: true });
  await put("game-a/runtime-baseline.json", { schemaVersion: 2, sc2: { dataBuild: "B97579" } });
  await put("game-a/core/GameA.SC2Mod/GameA.Core.json", { galaxy: { modules: [] } });
  await put("game-a/core/GameA.SC2Mod/Base.SC2Data/GameData.xml", "<Includes/>");
  await mkdir(path.join(repoRoot, "game-a/core/GameA.SC2Mod/Base.SC2Data/GameData"), { recursive: true });
  await put("game-a/core/GameA.SC2Mod/zhCN.SC2Data/LocalizedData/GameStrings.txt", "Test/Name=Old\n");
  await put("casc/manifest.json", { source: { version: "synthetic" } });
  await put("casc/files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata/unitdata.xml", '<Catalog><CUnit id="TestUnit"><LifeMax value="100"/></CUnit></Catalog>');
  const { databaseFile } = buildCascDatabase({ cascRoot: path.join(repoRoot, "casc"), output: path.join(repoRoot, "database") });
  const catalogRoot = path.join(repoRoot, "database/merged/GameData");
  const plan = { formatVersion: 2, id: "label", title: "label", target: "game-a.core",
    userSummary: { text: "将测试标签改为 New。" },
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 }, scope: { kind: "global" }, isolation: { strategy: "global" },
    operations: [{ opId: "label", kind: "locale.set", locale: "zhCN", key: "Test/Name", expect: "Old", value: "New" }] };
  const options = { repoRoot, runGameAValidation: false };
  const service = createPlanSubmissionService(options);
  const prepare = (runId = "run-test", custom = plan) => service.prepare({ planContent: custom,
    planPath: `game-a/drafts/${custom.id}.patch-plan.json`, catalogRoot, databaseFile, runId });
  const current = () => readFile(path.join(repoRoot, "game-a/core/GameA.SC2Mod/zhCN.SC2Data/LocalizedData/GameStrings.txt"), "utf8");
  return { repoRoot, options, service, prepare, current, put, plan, databaseFile, catalogRoot };
}

test('multi-edit preflight failure leaves every requested item unchanged', async t => {
  const f = await fixture(t);
  const plan = { ...f.plan, id: 'multi-failure', operations: [...f.plan.operations,
    { opId: 'wrong-current-life', kind: 'catalog.set', catalog: 'Unit', object: 'TestUnit', path: 'LifeMax', expect: 999, value: 120 }] };
  await assert.rejects(f.prepare('multi-test', plan));
  assert.equal(await f.current(), 'Test/Name=Old\n');
  assert.deepEqual(f.service.status(), []);
});

test('P2 request cannot prepare unconditional stats even when title and summary claim P2', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.databaseFile);
  db.prepare('INSERT INTO commanders (id,commander_object_id,user_reference,name_key,name_zhcn,name_enus) VALUES (?,?,?,?,?,?)')
    .run('TestCommander', 'TestCommander', 'TestCommander', 'TestCommander', 'TestCommander', 'TestCommander');
  db.prepare('INSERT INTO commander_profiles VALUES (?,?)').run('TestCommander', JSON.stringify({ prestiges: [{ index: 1, id: 'TestPrestige' }] }));
  db.prepare('INSERT INTO catalog_objects(catalog,object_id,class,is_default,source_file,direct_xml) VALUES (?,?,?,?,?,?)')
    .run('Upgrade','TestPrestige','CUpgrade',0,'synthetic.xml','<CUpgrade id="TestPrestige"/>');
  db.close();
  const tasks = createAgentTaskStore(f.repoRoot);
  const task = tasks.begin({ id: 'p2-test', runId: 'p2-run', prompt: '仅在 P2 中将 TestUnit 生命改为200；其他威望不变。' });
  const plan = { ...f.plan, id: 'p2-stats', title: 'P2 only', userSummary: { text: 'P2 only' },
    scope: { kind: 'commander', commanderId: 'TestCommander' }, isolation: { strategy: 'player-upgrade' },
    operations: [{ opId: 'life', kind: 'commander.stat.set', commanderId: 'TestCommander', catalog: 'Unit', object: 'TestUnit', path: 'LifeMax', expect: 100, value: 200 }] };
  await assert.rejects(f.service.prepare({ planContent: plan, planPath: 'game-a/drafts/p2-stats.patch-plan.json',
    catalogRoot: f.catalogRoot, databaseFile: f.databaseFile, taskId: task.id, runId: 'p2-run' }), /original request specifies P2.*TestPrestige/);
  assert.deepEqual(f.service.status(), []);
  assert.equal(await f.current(), 'Test/Name=Old\n');
  assert.doesNotThrow(() => validatePrestigeContract(plan, { databaseFile: f.databaseFile, request: '修改基础生命；不要改 P2 机制。' }));
  assert.doesNotThrow(() => validatePrestigeContract(plan, { databaseFile: f.databaseFile,
    request: '把基础生命改为 200。', requestReplies: ['同步保留 P2 的 75% 减免'] }),
  'preserving a prestige-derived relation does not make the base stat prestige-only');
  assert.doesNotThrow(() => validatePrestigeContract({ ...plan, operations: plan.operations.map(op => ({ ...op, prestigeUpgrade: 'TestPrestige' })) },
    { databaseFile: f.databaseFile, request: '仅在 P2 中修改生命。' }));
  assert.doesNotThrow(() => validatePrestigeContract({ ...plan, operations: plan.operations.map(op => ({ ...op, prestigeUpgrade: 'TestPrestige' })) },
    { databaseFile: f.databaseFile, request: '仅在 P1 中修改生命。', requestReplies: ['请改为 P2 的生命值。', '是的'] }));
  assert.throws(() => validatePrestigeContract(plan,
    { databaseFile: f.databaseFile, request: '仅在 P1 中修改生命。', requestReplies: ['请改为 P2 的生命值。'] }), /original request specifies P2/);
  assert.throws(() => validatePrestigeContract(plan,
    { databaseFile: f.databaseFile, request: '仅在 P2 中修改生命。', requestReplies: ['不要改 P1。'] }), /original request specifies P2/);

  const timedTask = tasks.begin({ id: 'p2-order-test', runId: 'p2-order-run',
    prompt: '仅在 P2 中将 TestUnit 生命改为200。只有能证明修改在原版威望应用后实际激活时才提交，否则不要提交。' });
  const generatedUpgradePlan = { ...plan, id: 'p2-ordered-stats',
    operations: plan.operations.map(op => ({ ...op, prestigeUpgrade: 'TestPrestige' })) };
  await assert.rejects(f.service.prepare({ planContent: generatedUpgradePlan,
    planPath: 'game-a/drafts/p2-ordered-stats.patch-plan.json', catalogRoot: f.catalogRoot,
    databaseFile: f.databaseFile, taskId: timedTask.id, runId: 'p2-order-run' }),
  error => error.code === 'request-binding-mismatch' && /REQUEST_CONDITION_TIMING_MISMATCH/.test(error.message));
  assert.deepEqual(f.service.status(), []);
});

test('task-bound preparation rejects a global retry when the user named one commander', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.databaseFile);
  db.prepare('INSERT INTO commanders (id,commander_object_id,user_reference,name_key,name_zhcn,name_enus) VALUES (?,?,?,?,?,?)')
    .run('TestCommander', 'TestCommander', 'TestCommander', 'TestCommander', '测试指挥官', 'Test Commander');
  db.close();
  const tasks = createAgentTaskStore(f.repoRoot);
  const task = tasks.begin({ id: 'scope-test', runId: 'scope-run', prompt: '只修改 Test Commander 的数值，不影响其他指挥官。' });
  await assert.rejects(f.service.prepare({ planContent: f.plan, planPath: 'game-a/drafts/global-retry.patch-plan.json',
    catalogRoot: f.catalogRoot, databaseFile: f.databaseFile, taskId: task.id, runId: 'scope-run' }),
  error => error.code === 'request-binding-mismatch' && /REQUEST_SCOPE_MISMATCH/.test(error.message));
  const saved = tasks.get({ id: task.id }).requestBinding;
  assert.deepEqual(saved.scope.commanderIds, ['TestCommander']);
  assert.deepEqual(f.service.status(), []);
  assert.equal(await f.current(), 'Test/Name=Old\n');
});

test("preparation is not submission; immutable selection applies once across process/service lifetimes", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  assert.equal(prepared.status, "prepared");
  assert.equal(await f.current(), "Test/Name=Old\n");
  assert.deepEqual(await f.service.recover(), []);
  await assert.rejects(f.service.submit({ preparationId: prepared.preparationId, retryOnly: true }), /not been selected/);
  await f.put(prepared.planPath, { ...f.plan, operations: [] });
  const applied = await f.service.submit({ preparationId: prepared.preparationId, runId: "run-test" });
  assert.equal(applied.status, "applied");
  assert.equal(await f.current(), "Test/Name=New\n");
  assert.equal(applied.report.receipt.preparationId, prepared.preparationId);
  const restarted = createPlanSubmissionService(f.options);
  assert.deepEqual(await restarted.submit({ preparationId: prepared.preparationId }), applied);
  assert.equal(restarted.status()[0].state, "applied");
  assert.equal(f.service.compact(applied).planSha256, undefined);
});

test('task-bound submission applies the selected iteration and retains outstanding reminders after restart', async t => {
  const f = await fixture(t); const tasks = createAgentTaskStore(f.repoRoot);
  const ctx = { id: 'delivery-test', runId: 'run-test', phase: 1 };
  tasks.begin({ ...ctx, prompt: 'Change two labels' }); tasks.open(ctx);
  const draftPath = 'game-a/drafts/label.patch-plan.json';
  await f.put(draftPath, f.plan);
  tasks.draft({ ...ctx, draftPath, plan: f.plan });
  const prepared = await f.service.prepare({ planContent: f.plan, planPath: draftPath, catalogRoot: f.catalogRoot, runId: ctx.runId, taskId: ctx.id });
  const extended = { ...f.plan, operations: [...f.plan.operations, { ...f.plan.operations[0], opId: 'second', key: 'Test/Second', expect: null }] };
  await f.put(draftPath, extended); tasks.draft({ ...ctx, draftPath, plan: extended });
  const restarted = createPlanSubmissionService(f.options);
  const applied = await restarted.submit({ preparationId: prepared.preparationId });
  assert.equal(applied.status, 'applied');
  assert.equal(tasks.get(ctx).selectedPreparation, prepared.preparationId);
  assert.equal(await f.current(), 'Test/Name=New\n');
  const review = createAgentTaskStore(f.repoRoot).working(ctx).delivery;
  assert.equal(review.policy, 'advisory');
  assert.equal(review.openCount, 1);
  assert.match(review.items.find(i => i.status === 'open').description, /Test\/Second/);
  // MCP retries return the persisted reminders alongside the actual applied status.
  const values = { COOPAGENT_TASK_ID: ctx.id, COOPAGENT_RUN_ID: ctx.runId, COOPAGENT_TASK_PHASE: String(ctx.phase) };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(values)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const core = createCoopAgentCore({ repoRoot: f.repoRoot });
  const retry = await core.submitPlan({ preparationId: prepared.preparationId });
  assert.equal(retry.status, 'applied');
  assert.deepEqual(retry.delivery, review);
});

test("the durable submission boundary rejects an expired phase, then recovers an accepted phase job exactly once", async (t) => {
  const f = await fixture(t);
  let now = 1;
  const tasks = createAgentTaskStore(f.repoRoot, { now: () => now, budgetMs: 300_000 });
  const ctx = { id: 'task-test', runId: 'run-test', phase: 1 };
  tasks.begin({ ...ctx, prompt: 'Change label' }); tasks.open(ctx);
  const prepared = await f.prepare();
  const selectCommit = (commit) => tasks.select({ ...ctx, preparationId: prepared.preparationId }, commit);
  now = 300_001;
  await assert.rejects(f.service.submit({ preparationId: prepared.preparationId, selectOnly: true, selectCommit }), /phase has ended/);
  assert.deepEqual(f.service.status(), []);
  assert.equal(await f.current(), 'Test/Name=Old\n');
  now = 100;
  await f.service.submit({ preparationId: prepared.preparationId, selectOnly: true, selectCommit });
  assert.equal(tasks.finish({ ...ctx, reason: 'budget' }).status, 'submitted');
  assert.equal((await f.service.recover()).length, 1);
  assert.equal(f.service.status()[0].state, 'applied');
  assert.equal(await f.current(), 'Test/Name=New\n');
  const again = await f.service.recover();
  assert.equal(again.length, 1);
  assert.equal(again[0].state, 'applied');
  assert.equal(await f.current(), 'Test/Name=New\n');
});

test('core prepare saves a real failed rehearsal diagnostic for the next turn', async (t) => {
  const f = await fixture(t);
  const values = { COOPAGENT_TASK_ID: 'task-core', COOPAGENT_RUN_ID: 'run-test', COOPAGENT_TASK_PHASE: '1' };
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(values)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const tasks = createAgentTaskStore(f.repoRoot);
  const ctx = { id: 'task-core', runId: 'run-test', phase: 1 };
  tasks.begin({ ...ctx, prompt: 'Change label' }); tasks.open(ctx);
  const core = createCoopAgentCore(f.options);
  const plan = structuredClone(f.plan); plan.operations[0].expect = 'NOT_THE_CURRENT_VALUE';
  await assert.rejects(core.preparePlan({ plan, catalogRoot: f.catalogRoot }), (error) => {
    assert.equal(error.name, 'CoopToolError');
    assert.equal(error.details.status, 'error');
    assert.ok(error.details.error.length > 0); return true;
  });
  tasks.finish({ ...ctx, reason: 'budget' });
  const nextCtx = { id: ctx.id, runId: 'run-next', phase: 2 };
  tasks.begin({ ...nextCtx, prompt: 'Continue from the saved failed preflight', resumeId: ctx.id });
  const next = tasks.open(nextCtx);
  assert.equal(next.context.evidence[0].query.operation, 'plan_prepare');
  assert.equal(tasks.get({ id: ctx.id, key: next.context.evidence[0].key }).status, 'error');
  assert.equal(await f.current(), 'Test/Name=Old\n');
  assert.deepEqual(f.service.status(), []);
});

for (const input of ["core", "baseline", "database", "catalog", "schema", "receipts"]) {
  test(`submission refuses changed ${input} context without writing Map Runtime`, async (t) => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    if (input === "core") await f.put("game-a/core/GameA.SC2Mod/independent.txt", "external edit");
    if (input === "baseline") await f.put("game-a/runtime-baseline.json", { schemaVersion: 2, sc2: { dataBuild: "B-other" } });
    if (input === "database") { const db = new DatabaseSync(f.databaseFile); db.exec("CREATE TABLE new_build_marker(id)"); db.close(); }
    if (input === "catalog") await f.put("database/merged/GameData/AdditionalData.xml", "<Catalog/>");
    if (input === "schema") await f.put("docs/schemas/new-schema.json", "{}");
    if (input === "receipts") await f.put("game-a/patches/other.receipt.json", { planId: "other" });
    await assert.rejects(f.service.submit({ preparationId: prepared.preparationId }), (error) => error.code === "preparation-stale");
    assert.equal(await f.current(), "Test/Name=Old\n");
    assert.equal(f.service.status()[0].state, "stale");
  });
}

test("failed atomic application keeps its selected job and succeeds on explicit retry", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const broken = createPlanSubmissionService({ ...f.options, transactionHooks: {
    beforeInstall: (_entry, index) => { if (index === 1) throw new Error("injected locked file"); },
  } });
  await assert.rejects(broken.submit({ preparationId: prepared.preparationId }), /injected locked file/);
  assert.equal(await f.current(), "Test/Name=Old\n");
  assert.equal(broken.status()[0].state, "failed");
  const applied = await f.service.submit({ preparationId: prepared.preparationId, retryOnly: true });
  assert.equal(applied.status, "applied");
  assert.equal(await f.current(), "Test/Name=New\n");
});

test("cancellation blocks unselected/precommit work, but cannot undo a completed receipt", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const release = acquireGameALock(f.repoRoot);
  try {
    await assert.rejects(f.service.submit({ preparationId: prepared.preparationId }), /正在预检/);
    assert.equal(f.service.status()[0].state, "submitted", "selection survives a busy project");
    f.service.cancelRun("run-test");
  } finally { release(); }
  await f.service.recover();
  assert.equal(f.service.status()[0].state, "cancelled");
  await assert.rejects(f.service.submit({ preparationId: prepared.preparationId }), (error) => error.code === "run-cancelled");
  assert.equal(await f.current(), "Test/Name=Old\n");
  const next = await f.prepare("next-run");
  await f.service.submit({ preparationId: next.preparationId });
  f.service.cancelRun("next-run");
  assert.equal((await f.service.submit({ preparationId: next.preparationId })).status, "applied");
});

test("a selected job resumes after a real process exits halfway through file installation", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  const module = pathToFileURL(path.join(repository, "scripts/lib/plan-submission.mjs")).href;
  const program = `import {createPlanSubmissionService} from ${JSON.stringify(module)};
    const service=createPlanSubmissionService({...${JSON.stringify(f.options)}, transactionHooks:{afterInstall:(_entry,index)=>{if(index===0)process.exit(42);}}});
    await service.submit({preparationId:${JSON.stringify(prepared.preparationId)}});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(child.status, 42, child.stderr);
  assert.equal(f.service.status()[0].state, "applying");
  const recovered = await f.service.recover();
  assert.equal(recovered[0].state, "applied");
  assert.equal(await f.current(), "Test/Name=New\n");
  assert.deepEqual(await f.service.recover(), recovered);
});

test("only one selected successful plan is allowed per Agent run", async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  const other = await f.prepare("run-test", { ...f.plan, id: "other" });
  await f.service.submit({ preparationId: first.preparationId });
  await assert.rejects(f.service.submit({ preparationId: other.preparationId }), (error) => error.code === "run-already-submitted");
});

test("a scheduled retry clears the old failure, while stale or cancelled preparations cannot be rescheduled", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await f.service.submit({ preparationId: prepared.preparationId, selectOnly: true });
  await f.service.workerFailed(prepared.preparationId, "worker unavailable");
  assert.equal(f.service.getJob(prepared.preparationId).state, "failed");
  await f.service.submit({ preparationId: prepared.preparationId, selectOnly: true });
  assert.equal(f.service.getJob(prepared.preparationId).state, "submitted");
  assert.equal(f.service.getJob(prepared.preparationId).error, null);
  await f.put("game-a/core/GameA.SC2Mod/external.txt", "changed");
  await assert.rejects(f.service.submit({ preparationId: prepared.preparationId }), { code: "preparation-stale" });
  await assert.rejects(f.service.submit({ preparationId: prepared.preparationId, selectOnly: true }), { code: "preparation-stale" });
  assert.equal(await f.current(), "Test/Name=Old\n");
});

test("worker errors never replace an applied receipt or a live competing commit", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await f.service.submit({ preparationId: prepared.preparationId, selectOnly: true });
  const release = acquireGameALock(f.repoRoot);
  try { await assert.rejects(f.service.workerFailed(prepared.preparationId, "another worker failed"), { code: "project-busy" }); }
  finally { release(); }
  assert.equal(f.service.getJob(prepared.preparationId).state, "submitted");
  await f.service.submit({ preparationId: prepared.preparationId });
  assert.equal((await f.service.workerFailed(prepared.preparationId, "late failure")).state, "applied");
});

test("core prepare and submit cross the real detached worker boundary without rereading a mutable draft", async (t) => {
  const f = await fixture(t);
  // Small fixture validators exercise the actual PowerShell/process boundary;
  // gameplay/catalog validation is covered by the separate executor suites.
  await f.put("game-a/scripts/validate-game-a.ps1", '$ErrorActionPreference="Stop"\nif (!(Test-Path "$PSScriptRoot/../core/GameA.SC2Mod/GameA.Core.json")) { throw "Missing staged core" }\n');
  await f.put("game-a/scripts/build-game-a.ps1", 'param([switch]$Check)\nif (!$Check) { throw "Unexpected build" }\n');
  const core = createCoopAgentCore({ repoRoot: f.repoRoot, runId: "worker-test" });
  const prepared = await core.preparePlan({ plan: f.plan, catalogRoot: f.catalogRoot });
  assert.equal(prepared.status, "prepared");
  assert.equal(await f.current(), "Test/Name=Old\n");
  await f.put("game-a/drafts/label.patch-plan.json", { ...f.plan, operations: [] });
  const result = await core.submitPlan({ preparationId: prepared.preparationId });
  assert.equal(result.status, "applied");
  assert.equal(result.runtimeVerified, false);
  assert.equal(await f.current(), "Test/Name=New\n");
  assert.deepEqual(await core.submitPlan({ preparationId: prepared.preparationId }), result);
});

test("a confirmed worker exit reconciles the receipt before reporting failure", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare();
  await f.service.submit({ preparationId: prepared.preparationId });
  // Exact durable state in the crash window: committed receipt, job still applying.
  const db = new DatabaseSync(path.join(f.repoRoot, "game-a/runtime/plan-jobs.sqlite"));
  db.prepare("UPDATE jobs SET state='applying',result=NULL WHERE preparation_id=?").run(prepared.preparationId);
  db.close();
  const recovered = await f.service.workerFailed(prepared.preparationId, "worker exited");
  assert.equal(recovered.state, "applied");
  assert.equal(recovered.result.report.receipt.preparationId, prepared.preparationId);
  assert.equal(await f.current(), "Test/Name=New\n");
});
