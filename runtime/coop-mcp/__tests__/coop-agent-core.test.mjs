import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CoopToolError,
  DEFAULT_REPO_ROOT,
  createCoopAgentCore,
  resolveRepoPath,
  sha256File,
} from "../lib/coop-agent-core.mjs";
import { attachPatchExecution, reviewPatchPlan } from "../lib/patch-plan-review.mjs";

const patchFixturePlan = {
  formatVersion: 2,
  id: "status-bar-fixture",
  title: "Status bar fixture",
  userSummary: { text: "调整测试对象的状态条参数。" },
  target: "game-a.core",
  compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
  scope: { kind: "global" },
  isolation: { strategy: "global" },
  operations: [
    { opId: "show-life", kind: "catalog.set", catalog: "Actor", object: "TestStatusActor", path: "StatusBarFlags[Life]", expect: 0, value: 1 },
    { opId: "enable-life", kind: "catalog.set", catalog: "Actor", object: "TestStatusActor", path: "StatusBarOn[Life]", expect: null, value: 1 },
    { opId: "set-offset", kind: "catalog.set", catalog: "Actor", object: "TestStatusActor", path: "BarOffset", expect: null, value: 95 },
    { opId: "set-width", kind: "catalog.set", catalog: "Actor", object: "TestStatusActor", path: "BarWidth", expect: null, value: 78 },
  ],
};

async function createPatchFixture(t) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "coopagent-core-plan-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const planPath = `game-a/patches/${patchFixturePlan.id}.patch-plan.json`;
  const absolutePlanPath = path.join(repoRoot, planPath);
  await mkdir(path.dirname(absolutePlanPath), { recursive: true });
  await cp(
    path.join(DEFAULT_REPO_ROOT, "game-a", "runtime-baseline.json"),
    path.join(repoRoot, "game-a", "runtime-baseline.json"),
  );
  await writeFile(absolutePlanPath, `${JSON.stringify(patchFixturePlan, null, 2)}\n`, "utf8");
  return { repoRoot, planPath, absolutePlanPath };
}

test("resolveRepoPath confines plans to the repository and excludes generated builds", () => {
  assert.equal(
    resolveRepoPath(DEFAULT_REPO_ROOT, "docs/examples/elite-marine.patch-plan.json"),
    path.join(DEFAULT_REPO_ROOT, "docs", "examples", "elite-marine.patch-plan.json"),
  );
  assert.throws(
    () => resolveRepoPath(DEFAULT_REPO_ROOT, "../outside.json"),
    CoopToolError,
  );
  assert.throws(
    () => resolveRepoPath(DEFAULT_REPO_ROOT, "game-a/build/change.json", {
      forbiddenRoots: ["game-a/build"],
    }),
    /cannot target game-a\/build/,
  );
});

test("projectStatus reports the accepted runtime and clean patch state", async () => {
  const core = createCoopAgentCore({ repoRoot: DEFAULT_REPO_ROOT });
  const status = await core.projectStatus();

  assert.equal(status.status, "ok");
  assert.equal(status.agentCoreStage, "domain-tools");
  assert.equal(status.runtime.baselineStatus, "accepted");
  assert.equal(status.runtime.sc2DataBuild, "B97579");
  assert.ok(status.runtime.hosts.some((host) => host.id === "oblivion-express"));
  assert.equal(status.patchPlans.appliedCount, 0);
});

test("projectStatus discovers the versioned local CASC database", async () => {
  const localAppDataDirectory = await mkdtemp(path.join(os.tmpdir(), "coop-agent-data-"));
  const catalogRoot = path.join(
    localAppDataDirectory,
    "CoopAgent",
    "database",
    "B97579",
    "merged",
    "GameData",
  );
  await mkdir(catalogRoot, { recursive: true });
  const core = createCoopAgentCore({ repoRoot: DEFAULT_REPO_ROOT, localAppDataDirectory });
  const status = await core.projectStatus();

  assert.equal(status.prerequisites.cascDatabase.exists, true);
  assert.equal(status.prerequisites.cascDatabase.source, "local-database");
  assert.equal(status.prerequisites.cascDatabase.path, catalogRoot);
});

test("patch_plan_write only writes validated drafts and allows draft revision", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "coop-agent-draft-"));
  const schemas = path.join(repoRoot, "docs", "schemas");
  await mkdir(schemas, { recursive: true });
  await cp(
    path.join(DEFAULT_REPO_ROOT, "docs", "schemas", "patch-plan.schema.json"),
    path.join(schemas, "patch-plan.schema.json"),
  );
  await cp(
    path.join(DEFAULT_REPO_ROOT, "docs", "schemas", "patch-plan-v2.schema.json"),
    path.join(schemas, "patch-plan-v2.schema.json"),
  );

  const core = createCoopAgentCore({ repoRoot });
  const plan = {
    formatVersion: 2,
    id: "agent-written-draft",
    title: "Agent written draft",
    userSummary: { text: "将测试标签更新为 draft。" },
    target: "game-a.core",
    compatibility: { sc2DataBuild: "B1", runtimeContract: 2 },
    scope: { kind: "global" },
    isolation: { strategy: "global" },
    operations: [{
      opId: "write-label",
      kind: "locale.set",
      locale: "zhCN",
      key: "GameA/Test/Label",
      value: "draft",
    }],
  };

  const first = await core.writePatchPlan({ plan });
  assert.equal(first.status, "written");
  assert.equal(first.planPath, "game-a/drafts/agent-written-draft.patch-plan.json");
  assert.equal(first.overwritten, false);
  const stored = JSON.parse(await readFile(path.join(repoRoot, first.planPath), "utf8"));
  assert.equal(stored.$schema, "../../docs/schemas/patch-plan-v2.schema.json");
  assert.equal(stored.title, plan.title);
  assert.deepEqual(stored.userSummary, plan.userSummary);
  assert.deepEqual(stored.scope, { kind: "global" });
  assert.deepEqual(stored.isolation, { strategy: "global" });

  const second = await core.writePatchPlan({ plan: { ...plan, title: "Revised draft" } });
  assert.equal(second.overwritten, true);
  await assert.rejects(
    core.writePatchPlan({ plan: { ...plan, id: "missing-scope", scope: undefined } }),
    /must declare both scope and isolation/,
  );
  const { userSummary: _summary, ...planWithoutSummary } = plan;
  await assert.rejects(
    core.writePatchPlan({ plan: { ...planWithoutSummary, id: "missing-summary" } }),
    /must include one concise userSummary\.text/,
  );
  await assert.rejects(core.writePatchPlan({ plan: { id: "invalid" } }), /Unsupported PatchPlan formatVersion/);

  const appliedDirectory = path.join(repoRoot, "game-a", "patches");
  await mkdir(appliedDirectory, { recursive: true });
  await writeFile(path.join(appliedDirectory, `${plan.id}.patch-plan.json`), "{}\n", "utf8");
  await assert.rejects(core.writePatchPlan({ plan }), /already been applied/);
});

test("patch_plan_check invokes the executor in rehearsal mode and returns a stable hash", async (t) => {
  const fixture = await createPatchFixture(t);
  const calls = [];
  const core = createCoopAgentCore({
    repoRoot: fixture.repoRoot,
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({ id: patchFixturePlan.id, mode: "check",
          planSha256: await sha256File(args[1]),
          review: reviewPatchPlan(JSON.parse(await readFile(args[1], "utf8")), { phase: "pre" }) }),
        stderr: "",
      };
    },
  });
  const result = await core.checkPatchPlan({ planPath: fixture.planPath });

  assert.equal(result.status, "checked");
  assert.equal(result.planSha256, await sha256File(fixture.absolutePlanPath));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--check"));
  assert.ok(calls[0].args.includes("--json"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--expected-plan-sha256") + 1], result.planSha256);
  assert.equal(result.review.status, "passed");
  assert.equal(result.review.summary.operationCount, 4);
  assert.equal(result.review.changes[0].target, "catalog/Actor/TestStatusActor/StatusBarFlags[Life]");
  assert.equal(result.review.userSummary.verificationLevel, "static-preflight");
  assert.equal(result.review.userSummary.runtimeVerified, false);
  assert.deepEqual(result.warnings, []);
});

test("PatchPlan review projects operations and reports only deterministic static risks", () => {
  const review = reviewPatchPlan({
    formatVersion: 2,
    id: "static-review",
    title: "Static review",
    target: "game-a.core",
    operations: [
      {
        opId: "clone-marine",
        kind: "catalog.clone",
        catalog: "Unit",
        source: "Marine",
        object: "GameAReviewMarine",
      },
      {
        opId: "set-life",
        kind: "catalog.set",
        catalog: "Unit",
        object: "GameAReviewMarine",
        path: "LifeMax",
        value: 100,
      },
      {
        opId: "typo-shields",
        kind: "catalog.set",
        catalog: "Unit",
        object: "GameAReviewMarine",
        path: "ShieldMax",
        expect: 0,
        value: 50,
      },
      {
        opId: "clear-abilities",
        kind: "catalog.clear",
        catalog: "Unit",
        object: "GameAReviewMarine",
        path: "AbilArray",
      },
    ],
  });

  assert.equal(review.status, "warnings");
  assert.equal(review.summary.operationCount, 4);
  assert.deepEqual(
    review.affectedSystems,
    [{ system: "Catalog/Unit", operationCount: 4 }],
  );
  assert.deepEqual(
    review.diagnostics.map((item) => item.code),
    [
      "RAW_UNIT_CLONE_REQUIRES_COMPANIONS",
      "MISSING_EXPECT",
      "LIKELY_CATALOG_PATH_TYPO",
      "CLEAR_WITHOUT_PRECONDITION",
      "VITAL_START_NOT_UPDATED",
    ],
  );
  assert.equal(review.changes[1].summary, "Set catalog/Unit/GameAReviewMarine/LifeMax to 100.");
  assert.deepEqual(review.changes[1].precondition, { type: "none" });
  assert.equal(review.changes[0].result.action, "clone");
  assert.equal(review.userSummary.changeItems.length, 4);
  assert.equal(
    review.userSummary.changeItems[2].text,
    "GameAReviewMarine · ShieldMax 0 → 50",
  );
  assert.deepEqual(review.userSummary.changeItems[2].catalogTargets, [{
    catalog: "Unit",
    objectId: "GameAReviewMarine",
    path: "ShieldMax",
  }]);

  const executed = attachPatchExecution(review, [
    { opId: "clone-marine", status: "changed", verified: true },
    { opId: "set-life", status: "already", verified: true },
  ]);
  assert.equal(executed.changes[0].execution.status, "changed");
  assert.equal(executed.changes[1].execution.status, "already");
  assert.equal(executed.userSummary.verificationLevel, "static-preflight");
  assert.deepEqual(executed.summary.executionStatusCounts, {
    already: 1,
    changed: 1,
    "not-reported": 2,
  });
});

test("PatchPlan review uses one controlled user summary while retaining operation associations", () => {
  const review = reviewPatchPlan({
    formatVersion: 2,
    id: "controlled-user-summary",
    title: "Implementation title",
    userSummary: { text: "为阿塔尼斯新增可部署并可复生的英雄单位。" },
    target: "game-a.core",
    operations: [
      {
        opId: "create-hero",
        kind: "catalog.create",
        catalog: "Unit",
        object: "GameAArtanisHero",
        class: "CUnit",
      },
      {
        opId: "set-hero-life",
        kind: "catalog.set",
        catalog: "Unit",
        object: "GameAArtanisHero",
        path: "LifeMax",
        value: 1000,
      },
    ],
  });

  assert.deepEqual(review.userSummary.items, ["为阿塔尼斯新增可部署并可复生的英雄单位。"]);
  assert.equal(review.userSummary.truncated, false);
  assert.equal(review.userSummary.changeItems.length, 2);
});

test("PatchPlan semantic review rejects unknown commanders and database-backed field typos", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-database-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      INSERT INTO commanders VALUES ('ProtossArtanis', 'Artanis');
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT);
      INSERT INTO catalog_objects VALUES ('Unit', 'Dragoon', 'CUnit');
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'LifeMax', '100');
    `);
    database.close();

    const review = reviewPatchPlan({
      formatVersion: 2,
      id: "bad-semantic-plan",
      operations: [
        {
          opId: "bad-commander",
          kind: "commander.stat.set",
          commanderId: "ProtossArtaniTypo",
          catalog: "Unit",
          object: "Dragoon",
          path: "LifeMax",
          expect: 100,
          value: 300,
        },
        {
          opId: "bad-field",
          kind: "catalog.set",
          catalog: "Unit",
          object: "Dragoon",
          path: "LiefMax",
          expect: null,
          value: 999,
        },
      ],
    }, { databaseFile });

    assert.equal(review.status, "errors");
    assert.equal(review.summary.errorCount, 2);
    assert.equal(review.evidence.catalogDatabase.checked, true);
    assert.equal(review.diagnostics.some((item) => item.code === "UNKNOWN_COMMANDER"), true);
    assert.equal(review.diagnostics.some((item) => item.code === "UNKNOWN_FIELD_POSSIBLE_TYPO"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan postconditions verify projected ability, command, autocast, and passive contracts", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-postconditions-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      INSERT INTO commanders VALUES ('TestCommander', 'TestCommanderObject');
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT, parent_id TEXT);
      INSERT INTO catalog_objects VALUES
        ('Unit', 'TestMedic', 'CUnit', NULL),
        ('Abil', 'TestHeal', 'CAbilEffectTarget', NULL),
        ('Abil', 'NewAbility', 'CAbilEffectTarget', NULL),
        ('Button', 'TestHealButton', 'CButton', NULL),
        ('Button', 'TestPassiveButton', 'CButton', NULL),
        ('Button', 'NewAbilityButton', 'CButton', NULL),
        ('Requirement', 'TestHealEnabled', 'CRequirement', NULL),
        ('Requirement', 'TestPassiveEnabled', 'CRequirement', NULL),
        ('Requirement', 'AlternateRequirement', 'CRequirement', NULL);
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES
        ('Unit', 'TestMedic', 'AbilArray[#0].@Link', 'TestHeal'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#0].@Type', 'AbilCmd'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#0].@AbilCmd', 'TestHeal,Execute'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#0].@Face', 'TestHealButton'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#0].@Row', '2'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#0].@Column', '0'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#1].@Type', 'Passive'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#1].@Face', 'TestPassiveButton'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#1].@Requirements', 'TestPassiveEnabled'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#1].@Row', '2'),
        ('Unit', 'TestMedic', 'CardLayouts[#0].LayoutButtons[#1].@Column', '1'),
        ('Unit', 'TestMedic', 'CardLayouts[0].LayoutButtons[0].@Type', 'Passive'),
        ('Unit', 'TestMedic', 'CardLayouts[0].LayoutButtons[0].@Face', 'TestPassiveButton'),
        ('Unit', 'TestMedic', 'CardLayouts[0].LayoutButtons[0].@Requirements', 'TestPassiveEnabled'),
        ('Abil', 'TestHeal', 'CmdButtonArray[Execute].@Requirements', 'TestHealEnabled'),
        ('Abil', 'TestHeal', 'Flags[AutoCast]', '1'),
        ('Abil', 'TestHeal', 'Flags[AutoCastOn]', '1');
    `);
    database.close();

    const valid = reviewPatchPlan({
      formatVersion: 2,
      id: "valid-postconditions",
      operations: [
        {
          opId: "attach-new-ability",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "TestMedic",
          path: "AbilArray",
          index: 9,
          attributes: { Link: "NewAbility" },
        },
        {
          opId: "show-new-ability",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "TestMedic",
          path: "CardLayouts[0].LayoutButtons",
          index: 9,
          attributes: {
            Type: "AbilCmd",
            AbilCmd: "NewAbility,Execute",
            Face: "NewAbilityButton",
            Row: 2,
            Column: 2,
          },
        },
      ],
      postconditions: [
        {
          postId: "existing-ability-attached",
          kind: "unit.ability",
          unitId: "TestMedic",
          abilityId: "TestHeal",
        },
        {
          postId: "existing-command-visible",
          kind: "unit.command",
          unitId: "TestMedic",
          abilityId: "TestHeal",
          command: "Execute",
          buttonId: "TestHealButton",
          cardIndex: 0,
          row: 2,
          column: 0,
          requirementId: "TestHealEnabled",
        },
        {
          postId: "existing-autocast-enabled",
          kind: "unit.autocast",
          unitId: "TestMedic",
          abilityId: "TestHeal",
          command: "Execute",
          buttonId: "TestHealButton",
          requirementId: "TestHealEnabled",
          defaultOn: true,
        },
        {
          postId: "existing-passive-visible",
          kind: "unit.passive",
          unitId: "TestMedic",
          buttonId: "TestPassiveButton",
          requirementId: "TestPassiveEnabled",
        },
        {
          postId: "new-command-projected",
          kind: "unit.command",
          unitId: "TestMedic",
          abilityId: "NewAbility",
          command: "Execute",
          buttonId: "NewAbilityButton",
          cardIndex: 0,
          row: 2,
          column: 2,
          requirementId: null,
        },
      ],
    }, { databaseFile });

    assert.equal(valid.status, "passed");
    assert.equal(valid.summary.postconditionCount, 5);
    assert.equal(valid.postconditions.every((item) => item.status === "passed"), true);

    const invalid = reviewPatchPlan({
      formatVersion: 2,
      id: "invalid-postconditions",
      operations: [],
      postconditions: [
        {
          postId: "wrong-command",
          kind: "unit.command",
          unitId: "TestMedic",
          abilityId: "TestHeal",
          command: "Cancel",
          buttonId: "TestHealButton",
        },
        {
          postId: "wrong-autocast-default",
          kind: "unit.autocast",
          unitId: "TestMedic",
          abilityId: "TestHeal",
          command: "Execute",
          buttonId: "TestHealButton",
          defaultOn: false,
        },
        {
          postId: "wrong-passive-gate",
          kind: "unit.passive",
          unitId: "TestMedic",
          buttonId: "TestPassiveButton",
          requirementId: "AlternateRequirement",
        },
      ],
    }, { databaseFile });

    assert.equal(invalid.status, "errors");
    assert.equal(
      invalid.diagnostics.filter((item) => item.code === "POSTCONDITION_NOT_SATISFIED").length,
      3,
    );
    assert.deepEqual(invalid.postconditions[0].failures, ["visible-command-missing"]);
    assert.deepEqual(invalid.postconditions[1].failures, ["autocast-default-mismatch"]);
    assert.deepEqual(invalid.postconditions[2].failures, ["passive-command-missing"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan postconditions verify Effect chains, localization, and permanent Requirement locks", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-static-contracts-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      INSERT INTO commanders VALUES ('TestCommander', 'TestCommanderObject');
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT, parent_id TEXT);
      INSERT INTO catalog_objects VALUES
        ('Unit', 'TestCaster', 'CUnit', NULL),
        ('Abil', 'GoodAbility', 'CAbilEffectTarget', NULL),
        ('Abil', 'BrokenAbility', 'CAbilEffectTarget', NULL),
        ('Abil', 'LockedAbility', 'CAbilEffectInstant', NULL),
        ('Button', 'LockedAbilityButton', 'CButton', NULL),
        ('Effect', 'GoodRoot', 'CEffectSet', NULL),
        ('Effect', 'GoodChild', 'CEffectDamage', NULL),
        ('Effect', 'ProjectedChild', 'CEffectDamage', NULL),
        ('Effect', 'DetachedEffect', 'CEffectDamage', NULL),
        ('Effect', 'BrokenRoot', 'CEffectSet', NULL),
        ('Requirement', 'LockedGate', 'CRequirement', NULL),
        ('Requirement', 'FalseNode', 'CRequirementConst', NULL);
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES
        ('Unit', 'TestCaster', 'AbilArray[#0].@Link', 'LockedAbility'),
        ('Unit', 'TestCaster', 'CardLayouts[#0].LayoutButtons[#0].@Type', 'AbilCmd'),
        ('Unit', 'TestCaster', 'CardLayouts[#0].LayoutButtons[#0].@AbilCmd', 'LockedAbility,Execute'),
        ('Unit', 'TestCaster', 'CardLayouts[#0].LayoutButtons[#0].@Face', 'LockedAbilityButton'),
        ('Unit', 'TestCaster', 'CardLayouts[#0].LayoutButtons[#0].@Requirements', 'LockedGate'),
        ('Abil', 'GoodAbility', 'Effect[0]', 'GoodRoot'),
        ('Abil', 'BrokenAbility', 'Effect[0]', 'BrokenRoot'),
        ('Effect', 'GoodRoot', 'EffectArray[#0]', 'GoodChild'),
        ('Effect', 'BrokenRoot', 'EffectArray[#0]', 'MissingEffect'),
        ('Requirement', 'LockedGate', 'NodeArray[Show].@Link', 'FalseNode'),
        ('Requirement', 'FalseNode', 'Value', '0');
      CREATE TABLE localized_text(locale TEXT, text_key TEXT, value TEXT, source_file TEXT);
      INSERT INTO localized_text VALUES
        ('zhcn', 'Button/Name/GoodAbility', '治疗', 'fixture'),
        ('enus', 'Button/Name/GoodAbility', 'Heal', 'fixture'),
        ('zhcn', 'Button/Tooltip/GoodAbility', '恢复生命值', 'fixture');
      CREATE TABLE object_references(
        source_catalog TEXT, source_object_id TEXT, field_path TEXT,
        target_catalog TEXT, target_object_id TEXT, confidence REAL, evidence TEXT
      );
      INSERT INTO object_references VALUES
        ('Effect', 'GoodRoot', 'EffectArray[#0]', 'Effect', 'GoodChild', 1.0, 'fixture'),
        ('Effect', 'BrokenRoot', 'EffectArray[#0]', 'Effect', 'MissingEffect', 1.0, 'fixture'),
        ('Requirement', 'LockedGate', 'NodeArray[Show].@Link', 'Requirement', 'FalseNode', 1.0, 'fixture');
    `);
    database.close();

    const valid = reviewPatchPlan({
      formatVersion: 2,
      id: "valid-static-contracts",
      operations: [
        {
          opId: "append-projected-effect",
          kind: "catalog.insert",
          catalog: "Effect",
          object: "GoodRoot",
          path: "EffectArray",
          index: 1,
          value: "ProjectedChild",
        },
        {
          opId: "add-projected-localization",
          kind: "locale.set",
          locale: "enUS",
          key: "Button/Tooltip/GoodAbility",
          expect: null,
          value: "Restores life.",
        },
      ],
      postconditions: [
        {
          postId: "good-effect-chain",
          kind: "ability.effect-chain",
          abilityId: "GoodAbility",
          effectPath: "Effect[0]",
          rootEffectId: "GoodRoot",
          requiredEffectIds: ["GoodChild", "ProjectedChild"],
        },
        {
          postId: "good-localization",
          kind: "localization.present",
          entries: [
            { locale: "zhCN", key: "Button/Name/GoodAbility", expected: "治疗" },
            { locale: "enUS", key: "Button/Name/GoodAbility" },
            { locale: "enUS", key: "Button/Tooltip/GoodAbility", expected: "Restores life." },
          ],
        },
      ],
    }, { databaseFile });

    assert.equal(valid.status, "passed");
    assert.deepEqual(valid.postconditions[0].evidence.reachableEffectIds, [
      "GoodChild",
      "GoodRoot",
      "ProjectedChild",
    ]);
    assert.equal(valid.postconditions[1].evidence.entries.every((entry) => entry.present), true);

    const invalid = reviewPatchPlan({
      formatVersion: 2,
      id: "invalid-static-contracts",
      operations: [],
      postconditions: [
        {
          postId: "broken-effect-chain",
          kind: "ability.effect-chain",
          abilityId: "BrokenAbility",
          effectPath: "Effect[0]",
          rootEffectId: "BrokenRoot",
        },
        {
          postId: "unreachable-effect",
          kind: "ability.effect-chain",
          abilityId: "GoodAbility",
          effectPath: "Effect[0]",
          rootEffectId: "GoodRoot",
          requiredEffectIds: ["DetachedEffect"],
        },
        {
          postId: "bad-localization",
          kind: "localization.present",
          entries: [
            { locale: "zhCN", key: "Button/Name/GoodAbility", expected: "错误名称" },
            { locale: "enUS", key: "Button/Tooltip/Missing" },
          ],
        },
        {
          postId: "permanently-locked-command",
          kind: "unit.command",
          unitId: "TestCaster",
          abilityId: "LockedAbility",
          command: "Execute",
          buttonId: "LockedAbilityButton",
          requirementId: "LockedGate",
        },
      ],
    }, { databaseFile });

    assert.equal(invalid.status, "errors");
    assert.deepEqual(invalid.postconditions[0].failures, ["effect-link-target-missing"]);
    assert.deepEqual(invalid.postconditions[1].failures, ["required-effect-unreachable"]);
    assert.deepEqual(invalid.postconditions[2].failures, [
      "localization-missing",
      "localization-mismatch",
    ]);
    assert.deepEqual(invalid.postconditions[3].failures, ["requirement-permanently-locked"]);
    assert.deepEqual(invalid.postconditions[3].evidence.requirementStatic.phases, [{
      phase: "Show",
      objectId: "FalseNode",
      state: "false",
    }]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan unit clone contracts verify companions, entrypoints, localization, and vitals", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-unit-clone-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      INSERT INTO commanders VALUES ('TestCommander', 'TestCommanderObject');
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT, parent_id TEXT);
      INSERT INTO catalog_objects VALUES
        ('Unit', 'SourceUnit', 'CUnit', NULL),
        ('Actor', 'SourceUnitActor', 'CActorUnit', NULL),
        ('Actor', 'UnsupportedActor', 'CActorMissile', NULL),
        ('Model', 'SourceModel', 'CModel', NULL),
        ('Model', 'SourcePortrait', 'CModel', NULL),
        ('Abil', 'TestTrain', 'CAbilTrain', NULL);
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES
        ('Unit', 'SourceUnit', 'Name', 'Unit/Name/##id##'),
        ('Unit', 'SourceUnit', 'LifeMax', '300'),
        ('Unit', 'SourceUnit', 'LifeStart', '300'),
        ('Unit', 'SourceUnit', 'ShieldsMax', '100'),
        ('Unit', 'SourceUnit', 'ShieldsStart', '100'),
        ('Actor', 'SourceUnitActor', '@unitName', 'SourceUnit'),
        ('Actor', 'SourceUnitActor', 'Model', 'SourceModel'),
        ('Actor', 'SourceUnitActor', 'UnitIcon', 'Assets\\Textures\\source-unit.dds'),
        ('Actor', 'SourceUnitActor', 'Wireframe.Image', 'Assets\\Textures\\source-unit-wireframe.dds'),
        ('Actor', 'SourceUnitActor', 'GroupIcon.Image', 'Assets\\Textures\\source-unit-wireframe.dds'),
        ('Actor', 'SourceUnitActor', 'PortraitModel', 'SourcePortrait'),
        ('Actor', 'SourceUnitActor', 'StatusBarFlags[Life]', '1'),
        ('Actor', 'UnsupportedActor', '@unitName', 'SourceUnit'),
        ('Actor', 'UnsupportedActor', 'Model', 'SourceModel'),
        ('Abil', 'TestTrain', 'InfoArray[Train1].Unit', 'SourceUnit');
      ALTER TABLE catalog_fields ADD COLUMN inheritance_depth INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE localized_text(locale TEXT, text_key TEXT, value TEXT, source_file TEXT);
      INSERT INTO localized_text VALUES
        ('zhcn', 'Unit/Name/SourceUnit', '测试单位', 'fixture'),
        ('enus', 'Unit/Name/SourceUnit', 'Test Unit', 'fixture');
      CREATE TABLE object_references(
        source_catalog TEXT, source_object_id TEXT, field_path TEXT,
        target_catalog TEXT, target_object_id TEXT, confidence REAL, evidence TEXT
      );
      INSERT INTO object_references VALUES
        ('Abil', 'TestTrain', 'InfoArray[Train1].Unit', 'Unit', 'SourceUnit', 1.0, 'fixture');
    `);
    database.close();

    const baseClone = {
      opId: "clone-source-unit",
      kind: "commander.unit.clone",
      commanderId: "TestCommander",
      sourceUnit: "SourceUnit",
      sourceActor: "SourceUnitActor",
      unitId: "TestCommanderSourceUnit",
      actorId: "TestCommanderSourceUnitActor",
      redirects: [
        {
          catalog: "Abil",
          object: "TestTrain",
          path: "InfoArray[Train1].Unit[0]",
          expect: "SourceUnit",
        },
      ],
    };
    const baseContract = {
      postId: "complete-source-unit-clone",
      kind: "unit.clone",
      commanderId: "TestCommander",
      sourceUnitId: "SourceUnit",
      unitId: "TestCommanderSourceUnit",
      sourceActorId: "SourceUnitActor",
      actorId: "TestCommanderSourceUnitActor",
      entrypoints: [
        {
          kind: "catalog",
          catalog: "Abil",
          object: "TestTrain",
          path: "InfoArray[Train1].Unit[0]",
        },
      ],
      vitalPolicy: "preserve-source",
      nameKey: "Unit/Name/SourceUnit",
    };
    const valid = reviewPatchPlan({
      formatVersion: 2,
      id: "valid-unit-clone-contract",
      scope: { kind: "commander", commanderId: "TestCommander" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "SourceUnit" },
      },
      operations: [baseClone],
      postconditions: [baseContract],
    }, { databaseFile });

    assert.equal(valid.status, "passed");
    assert.equal(valid.summary.postconditionCount, 1);
    assert.deepEqual(valid.postconditions[0].failures, []);
    assert.equal(valid.postconditions[0].evidence.actorClass, "CActorUnit");
    assert.equal(valid.postconditions[0].evidence.modelExists, true);
    assert.equal(valid.postconditions[0].evidence.nameEntries.length, 2);
    assert.deepEqual(valid.postconditions[0].evidence.actorFieldPolicy, {
      inferredFromDirectSourceFields: 5,
      explicitlyRequired: 0,
    });
    assert.equal(
      valid.postconditions[0].evidence.actorFields.every((field) => field.source === "inferred"),
      true,
    );

    const invalid = reviewPatchPlan({
      formatVersion: 2,
      id: "invalid-unit-clone-contract",
      scope: { kind: "commander", commanderId: "TestCommander" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "SourceUnit" },
      },
      operations: [
        baseClone,
        {
          opId: "break-model",
          kind: "catalog.set",
          catalog: "Actor",
          object: "TestCommanderSourceUnitActor",
          path: "Model",
          value: "MissingModel",
        },
        {
          opId: "remove-icon",
          kind: "catalog.remove",
          catalog: "Actor",
          object: "TestCommanderSourceUnitActor",
          path: "UnitIcon",
        },
        {
          opId: "break-portrait",
          kind: "catalog.set",
          catalog: "Actor",
          object: "TestCommanderSourceUnitActor",
          path: "PortraitModel",
          value: "MissingPortrait",
        },
        {
          opId: "break-name",
          kind: "catalog.set",
          catalog: "Unit",
          object: "TestCommanderSourceUnit",
          path: "Name",
          value: "Unit/Name/TestCommanderSourceUnit",
        },
        {
          opId: "change-life-max",
          kind: "commander.stat.set",
          commanderId: "TestCommander",
          catalog: "Unit",
          object: "TestCommanderSourceUnit",
          path: "LifeMax",
          value: 450,
        },
      ],
      postconditions: [
        {
          ...baseContract,
          entrypoints: [
            ...baseContract.entrypoints,
            {
              kind: "catalog",
              catalog: "Abil",
              object: "MissingTrain",
              path: "InfoArray[Train2].Unit",
            },
          ],
          vitalPolicy: "full-start",
          nameKey: "Unit/Name/TestCommanderSourceUnit",
        },
      ],
    }, { databaseFile });

    assert.equal(invalid.status, "errors");
    assert.deepEqual(invalid.postconditions[0].failures, [
      "model-target-missing",
      "unit-name-localization-missing",
      "entrypoint-not-connected",
      "actor-field-missing",
      "actor-field-target-missing",
      "vitals-not-full-at-start",
    ]);

    const unsupportedActor = reviewPatchPlan({
      formatVersion: 2,
      id: "unsupported-source-actor",
      operations: [
        {
          ...baseClone,
          sourceActor: "UnsupportedActor",
          actorId: "UnsupportedActorClone",
        },
      ],
      postconditions: [
        {
          ...baseContract,
          sourceActorId: "UnsupportedActor",
          actorId: "UnsupportedActorClone",
          requiredActorFields: undefined,
          vitalPolicy: undefined,
        },
      ],
    }, { databaseFile });

    assert.equal(unsupportedActor.status, "errors");
    assert.equal(
      unsupportedActor.postconditions[0].failures.includes("source-actor-not-unit"),
      true,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan scope contracts keep scalar upgrades simple and reject structural writes to base objects", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-isolation-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      INSERT INTO commanders VALUES ('ProtossArtanis', 'Artanis');
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT, parent_id TEXT);
      INSERT INTO catalog_objects VALUES
        ('Unit', 'Dragoon', 'CUnit', NULL),
        ('Unit', 'EnemyDragoon', 'CUnit', 'Dragoon'),
        ('Abil', 'Blink', 'CAbilEffectTarget', NULL),
        ('Abil', 'GatewayTrain', 'CAbilTrain', NULL),
        ('Upgrade', 'DragoonArmor', 'CUpgrade', NULL);
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES
        ('Unit', 'Dragoon', 'LifeMax', '100'),
        ('Unit', 'Dragoon', 'LifeStart', '100'),
        ('Abil', 'Blink', 'Range', '8'),
        ('Abil', 'GatewayTrain', 'InfoArray[TrainDragoon].Unit', 'Dragoon'),
        ('Upgrade', 'DragoonArmor', 'AffectedUnitArray[#0]', 'Dragoon');
      CREATE TABLE commander_membership(
        commander_id TEXT, catalog TEXT, object_id TEXT, evidence TEXT, depth INTEGER
      );
      INSERT INTO commander_membership VALUES
        ('ProtossArtanis', 'Unit', 'Dragoon', 'fixture', 0);
      CREATE TABLE object_references(
        source_catalog TEXT, source_object_id TEXT, field_path TEXT,
        target_catalog TEXT, target_object_id TEXT, confidence REAL, evidence TEXT
      );
      INSERT INTO object_references VALUES
        ('Abil', 'GatewayTrain', 'InfoArray[TrainDragoon].Unit', 'Unit', 'Dragoon', 1.0, 'field-hint:Unit'),
        ('Upgrade', 'DragoonArmor', 'AffectedUnitArray[#0]', 'Unit', 'Dragoon', 1.0, 'field-hint:Unit');
    `);
    database.close();

    const scalar = reviewPatchPlan({
      formatVersion: 2,
      id: "scoped-scalar",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: { strategy: "player-upgrade" },
      operations: [
        {
          opId: "life-max",
          kind: "commander.stat.set",
          commanderId: "ProtossArtanis",
          catalog: "Unit",
          object: "Dragoon",
          path: "LifeMax",
          expect: 100,
          value: 300,
        },
        {
          opId: "life-start",
          kind: "commander.stat.set",
          commanderId: "ProtossArtanis",
          catalog: "Unit",
          object: "Dragoon",
          path: "LifeStart",
          expect: 100,
          value: 300,
        },
      ],
    }, { databaseFile });
    assert.equal(scalar.status, "passed");
    assert.equal(scalar.plan.isolation.strategy, "player-upgrade");

    const leaking = reviewPatchPlan({
      formatVersion: 2,
      id: "leaking-structure",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "Dragoon" },
      },
      operations: [{
        opId: "attach-blink-to-base",
        kind: "catalog.insert",
        catalog: "Unit",
        object: "Dragoon",
        path: "AbilArray",
        index: 0,
        attributes: { Link: "Blink" },
      }],
    }, { databaseFile });
    assert.equal(leaking.status, "errors");
    assert.equal(
      leaking.diagnostics.some((item) => item.code === "COMMANDER_SCOPE_WRITES_BASE_OBJECT"),
      true,
    );
    assert.equal(
      leaking.diagnostics.some((item) => item.code === "ISOLATION_OWNER_NOT_CLONED"),
      true,
    );

    const isolated = reviewPatchPlan({
      formatVersion: 2,
      id: "isolated-structure",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "Dragoon" },
      },
      operations: [
        {
          opId: "clone-dragoon",
          kind: "commander.unit.clone",
          commanderId: "ProtossArtanis",
          sourceUnit: "Dragoon",
          unitId: "GameAArtanisDragoon",
          redirects: [{
            catalog: "Abil",
            object: "GatewayTrain",
            path: "InfoArray[TrainDragoon].Unit[0]",
            expect: "Dragoon",
          }],
        },
        {
          opId: "clone-blink",
          kind: "catalog.clone",
          catalog: "Abil",
          source: "Blink",
          object: "GameAArtanisDragoonBlink",
        },
        {
          opId: "set-private-range",
          kind: "catalog.set",
          catalog: "Abil",
          object: "GameAArtanisDragoonBlink",
          path: "Range",
          expect: 8,
          value: 6,
        },
        {
          opId: "attach-private-blink",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "GameAArtanisDragoon",
          path: "AbilArray",
          index: 0,
          attributes: { Link: "GameAArtanisDragoonBlink" },
        },
      ],
    }, { databaseFile });
    assert.equal(isolated.status, "passed");

    const cloneWithoutCreationRedirect = reviewPatchPlan({
      formatVersion: 2,
      id: "clone-without-creation-redirect",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "Dragoon" },
      },
      operations: [{
        opId: "clone-dragoon-with-upgrade-only",
        kind: "commander.unit.clone",
        commanderId: "ProtossArtanis",
        sourceUnit: "Dragoon",
        unitId: "GameAUnreachableDragoon",
        redirects: [{
          catalog: "Upgrade",
          object: "DragoonArmor",
          path: "AffectedUnitArray[#0]",
          expect: "Dragoon",
        }],
      }],
    }, { databaseFile });
    assert.equal(
      cloneWithoutCreationRedirect.diagnostics.some(
        (item) => item.code === "UNIT_CLONE_MISSING_CREATION_REDIRECT",
      ),
      true,
    );

    const unwiredOwner = reviewPatchPlan({
      formatVersion: 2,
      id: "unwired-private-owner",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "Dragoon" },
      },
      operations: [{
        opId: "clone-runtime-hero",
        kind: "catalog.clone",
        catalog: "Unit",
        source: "Dragoon",
        object: "GameAArtanisHero",
      }],
    }, { databaseFile });
    assert.equal(
      unwiredOwner.diagnostics.some((item) => item.code === "ISOLATION_OWNER_NOT_REWIRED"),
      true,
    );

    const runtimeWiredOwner = reviewPatchPlan({
      formatVersion: 2,
      id: "runtime-wired-private-owner",
      scope: { kind: "commander", commanderId: "ProtossArtanis" },
      isolation: {
        strategy: "private-clone",
        owner: { catalog: "Unit", object: "Dragoon" },
      },
      operations: [
        {
          opId: "clone-runtime-hero",
          kind: "catalog.clone",
          catalog: "Unit",
          source: "Dragoon",
          object: "GameAArtanisHero",
        },
        {
          opId: "wire-runtime-hero",
          kind: "galaxy.source",
          path: "Base.SC2Data/Generated/ArtanisHero.galaxy",
          expectSha256: null,
          source: "void GameA_ArtanisHeroInit() {\n    string unitId = \"GameAArtanisHero\";\n}\n",
        },
      ],
    }, { databaseFile });
    assert.equal(
      runtimeWiredOwner.status,
      "warnings",
    );
    assert.equal(
      runtimeWiredOwner.diagnostics.some((item) => item.code === "ISOLATION_OWNER_NOT_REWIRED"),
      false,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan semantic review rejects invalid Unit array indexes and inherited ordinal collisions", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-review-array-slots-"));
  try {
    const databaseFile = path.join(temporary, "coop.sqlite");
    const database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE commanders(id TEXT, commander_object_id TEXT);
      CREATE TABLE catalog_objects(catalog TEXT, object_id TEXT, class TEXT);
      INSERT INTO catalog_objects VALUES ('Unit', 'Dragoon', 'CUnit');
      CREATE TABLE catalog_fields(catalog TEXT, object_id TEXT, path TEXT, value TEXT);
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'AbilArray[#0].@Link', 'stop');
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'AbilArray[#1].@Link', 'attack');
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'CardLayouts[#0].LayoutButtons[#0].@Face', 'Move');
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'CardLayouts[#0].LayoutButtons[#1].@Face', 'Stop');
      INSERT INTO catalog_fields VALUES ('Unit', 'Dragoon', 'CardLayouts[0].LayoutButtons[#0].@Face', 'DragoonRange');
    `);
    database.close();

    const review = reviewPatchPlan({
      formatVersion: 2,
      id: "bad-array-slots",
      operations: [
        {
          opId: "named-ability-slot",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "Dragoon",
          path: "AbilArray",
          index: "GameADragoonBlink",
          attributes: { Link: "GameADragoonBlink" },
        },
        {
          opId: "occupied-command-card-slot",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "Dragoon",
          path: "CardLayouts[0].LayoutButtons",
          index: 2,
          attributes: {
            Type: "AbilCmd",
            AbilCmd: "GameADragoonBlink,Execute",
            Face: "Blink",
          },
        },
      ],
    }, { databaseFile });

    assert.equal(review.status, "errors");
    assert.equal(review.diagnostics.some((item) => item.code === "INVALID_UNIT_ARRAY_INDEX"), true);
    const collision = review.diagnostics.find(
      (item) => item.code === "ARRAY_INDEX_COLLIDES_WITH_EFFECTIVE_ENTRY",
    );
    assert.equal(collision?.details.minimumFreeIndex, 3);
    assert.equal(
      review.diagnostics.some((item) => item.code === "BUTTON_ABILITY_NOT_ATTACHED"),
      true,
    );
    assert.equal(review.userSummary.items[0].includes("GameADragoonBlink"), true);

    const valid = reviewPatchPlan({
      formatVersion: 2,
      id: "valid-array-slots",
      title: "Dragoon gains Blink",
      operations: [
        {
          opId: "attach-blink",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "Dragoon",
          path: "AbilArray",
          index: 2,
          attributes: { Link: "GameADragoonBlink" },
        },
        {
          opId: "show-blink",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "Dragoon",
          path: "CardLayouts[0].LayoutButtons",
          index: 3,
          attributes: {
            Type: "AbilCmd",
            AbilCmd: "GameADragoonBlink,Execute",
            Face: "Blink",
          },
        },
      ],
    }, { databaseFile });
    assert.equal(valid.status, "passed");
    assert.equal(valid.diagnostics.length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan semantic review requires explicit chaining for repeated scalar targets", () => {
  const base = {
    formatVersion: 2,
    id: "repeated-write",
    operations: [{
      opId: "first",
      kind: "catalog.set",
      catalog: "Unit",
      object: "Dragoon",
      path: "LifeMax",
      expect: 100,
      value: 300,
    }],
  };
  const ambiguous = reviewPatchPlan({
    ...base,
    operations: [
      ...base.operations,
      { ...base.operations[0], opId: "second", expect: 100, value: 200 },
    ],
  });
  assert.equal(ambiguous.diagnostics.some((item) => item.code === "AMBIGUOUS_REWRITE"), true);

  const chained = reviewPatchPlan({
    ...base,
    operations: [
      ...base.operations,
      { ...base.operations[0], opId: "second", expect: 300, value: 200 },
    ],
  });
  assert.equal(chained.diagnostics.some((item) => item.code === "AMBIGUOUS_REWRITE"), false);
});

test("patch_plan_apply returns the same static review after hash approval", async (t) => {
  const fixture = await createPatchFixture(t);
  const calls = [];
  const core = createCoopAgentCore({
    repoRoot: fixture.repoRoot,
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: JSON.stringify({ id: patchFixturePlan.id, mode: "apply",
          planSha256: await sha256File(args[1]),
          review: reviewPatchPlan(JSON.parse(await readFile(args[1], "utf8")), { phase: "pre" }) }),
        stderr: "",
      };
    },
  });
  const approvedPlanSha256 = await sha256File(fixture.absolutePlanPath);
  const result = await core.applyPatchPlan({ planPath: fixture.planPath, approvedPlanSha256 });

  assert.equal(result.status, "applied");
  assert.equal(result.review.status, "passed");
  assert.equal(result.review.summary.operationCount, 4);
  assert.equal(result.review.userSummary.verificationLevel, "applied-to-source");
  assert.equal(result.review.userSummary.runtimeVerified, false);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.includes("--check"));
});

test("patch_plan_apply rejects a changed or unapproved plan before starting a process", async (t) => {
  const fixture = await createPatchFixture(t);
  let commandStarted = false;
  const core = createCoopAgentCore({
    repoRoot: fixture.repoRoot,
    commandRunner: async () => {
      commandStarted = true;
      return { stdout: "{}", stderr: "" };
    },
  });

  await assert.rejects(
    core.applyPatchPlan({
      planPath: fixture.planPath,
      approvedPlanSha256: "0".repeat(64),
    }),
    /does not match/,
  );
  assert.equal(commandStarted, false);
});

test("game_a_build only accepts registered hosts", async () => {
  const core = createCoopAgentCore({
    repoRoot: DEFAULT_REPO_ROOT,
    commandRunner: async () => ({ stdout: "not used", stderr: "" }),
  });

  await assert.rejects(core.buildGameA({ hostId: "not-a-host" }), /Unknown Game A host/);
});

test("runtime_test_start builds a registered host and launches only its generated map", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "coopagent-runtime-core-"));
  const gameARoot = path.join(repoRoot, "game-a");
  const generatedMap = path.join(gameARoot, "build", "versions", "fixture", "GameA-Fixture.SC2Map");
  const componentPath = path.join(generatedMap, "ComponentList.SC2Components");
  await mkdir(path.join(gameARoot, "scripts"), { recursive: true });
  await mkdir(generatedMap, { recursive: true });
  await writeFile(path.join(gameARoot, "hosts.json"), JSON.stringify({
    defaultHost: "fixture",
    hosts: [{ id: "fixture", outputName: "GameA-Fixture.SC2Map" }],
  }), "utf8");
  await writeFile(path.join(gameARoot, "runtime-baseline.json"), JSON.stringify({
    sc2: { version: "5.0.15.97579", dataBuild: "B97579" },
  }), "utf8");
  await writeFile(componentPath, "<Components/>", "utf8");

  const starts = [];
  const core = createCoopAgentCore({
    repoRoot,
    commandRunner: async () => ({ stdout: `${componentPath}\r\n`, stderr: "" }),
    runtimeTestService: {
      start: async (input) => {
        starts.push(input);
        return { status: "ok", run: { id: "fixture-run" }, verification: "pending" };
      },
      status: async () => ({ status: "not-run" }),
    },
  });

  const result = await core.startRuntimeTest({ startupTimeoutMs: 12_000 });
  assert.equal(result.run.id, "fixture-run");
  assert.equal(result.build.hostId, "fixture");
  assert.deepEqual(starts, [{
    hostId: "fixture",
    mapPath: generatedMap,
    buildHash: null,
    expectedSc2Version: "5.0.15.97579",
    expectedDataBuild: "B97579",
    startupTimeoutMs: 12_000,
    displayMode: 1,
  }]);
});

test("runtime_logs returns bounded tails from the SC2 log directory", async () => {
  const documentsDirectory = await mkdtemp(path.join(os.tmpdir(), "coop-agent-logs-"));
  const logsDirectory = path.join(documentsDirectory, "StarCraft II", "GameLogs");
  await mkdir(logsDirectory, { recursive: true });
  await writeFile(path.join(logsDirectory, "test ScriptError.txt"), "A".repeat(1_500), "utf8");

  const core = createCoopAgentCore({ repoRoot: DEFAULT_REPO_ROOT, documentsDirectory });
  const result = await core.latestRuntimeLogs({ kind: "script-error", maxChars: 1_000 });

  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].found, true);
  assert.equal(result.logs[0].truncated, true);
  assert.equal(result.logs[0].tail.length, 1_000);
});
