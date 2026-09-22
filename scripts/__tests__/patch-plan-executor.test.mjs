import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  applyPlanToCore,
  commanderUpgradeGalaxy,
  executePatchPlan,
  operationTarget,
  operationTargets,
  targetsConflict,
  validateGalaxySource,
  validatePatchPlan,
} from "../lib/patch-plan-executor.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaPath = path.join(repositoryRoot, "docs", "schemas", "patch-plan.schema.json");
const schemaV2Path = path.join(repositoryRoot, "docs", "schemas", "patch-plan-v2.schema.json");

test('User instance Id is not accepted as an array index and failed edit leaves core unchanged', async t => {
  const temporary=await mkdtemp(path.join(tmpdir(),'coop-user-id-'));
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  const core=await createCore(path.join(temporary,'core'));
  const catalogRoot=path.join(temporary,'catalog');
  await mkdir(catalogRoot);
  await writeFile(path.join(catalogRoot,'UserData.xml'),'<Catalog><CUser id="MasteryUpgrades"><Instances Id="ArtanisMastery1"><Fixed Fixed="3"><Field Id="PointIncrement"/></Fixed></Instances></CUser></Catalog>');
  const plan={formatVersion:1,id:'user-id-test',title:'User ID test',target:'game-a.core',compatibility:{sc2DataBuild:'B97579',runtimeContract:2},
    operations:[{kind:'catalog.set',opId:'point',catalog:'User',object:'MasteryUpgrades',path:'Instances[ArtanisMastery1].Fixed.@Fixed',expect:3,value:4}]};
  const before=await readFile(path.join(core,'Base.SC2Data/GameData.xml'),'utf8');
  await assert.rejects(applyPlanToCore({coreRoot:core,catalogRoot,plan}),/selects an index, not the instance Id/);
  assert.equal(await readFile(path.join(core,'Base.SC2Data/GameData.xml'),'utf8'),before);
  await assert.rejects(stat(path.join(core,'Base.SC2Data/GameData/UserData.xml')), {code:'ENOENT'});
});

test("prestige activation uses committed selection before official tech and grants only once", () => {
  const source = commanderUpgradeGalaxy({ commanderId: 'ProtossKarax', upgradeId: 'GeneratedStat',
    configureFunction: 'Configure', prestigeUpgrade: 'CommanderPrestigeKaraxArmy' });
  validateGalaxySource(source, 'Generated/Prestige.galaxy');
  // Execute the actual emitted control flow with API stubs. This is an offline
  // regression, NOT a Galaxy compiler or an SC2 engine result.
  const js = source.replace(/void Configure \(\)/, 'function Configure()')
    .replace(/\b(int|string|playergroup) (\w+);/g, 'let $2;');
  const players = [
    { commander: 'ProtossKarax', prestige: null },
    { commander: 'ProtossKarax', prestige: 'P1' },
    { commander: 'ProtossKarax', prestige: 'P2' },
    { commander: 'ProtossKarax', prestige: 'P3' },
    { commander: 'TerranRaynor', prestige: 'P2' },
    { commander: 'ProtossKarax', prestige: 'P2' },
  ].map(p => ({ ...p, count: 0, value: 100 }));
  const primary = { P1: 'Other1', P2: 'CommanderPrestigeKaraxArmy', P3: 'Other3' };
  const api = {
    c_techCountCompleteOnly: 1,
    libCOOC_gf_CommanderPlayers: () => players,
    PlayerGroupNextPlayer: (group, prev) => prev + 1 < group.length ? prev + 1 : -1,
    libCOOC_gf_ActiveCommanderForPlayer: p => players[p].commander,
    libCOOC_gf_CC_PlayerActivePrestigeInstance: p => players[p].prestige,
    UserDataGetGameLink: (type, instance, field, index) => {
      assert.equal(type, 'PlayerPrestige'); assert.notEqual(instance, null);
      assert.equal(field, 'PrimaryUpgrade'); assert.equal(index, 1);
      return primary[instance];
    },
    TechTreeUpgradeCount: (p, id) => {
      assert.equal(id, 'GeneratedStat', 'must not depend on official Upgrade grant timing');
      return players[p].count;
    },
    TechTreeUpgradeAddLevel: (p, id, level) => {
      assert.equal(id, 'GeneratedStat'); assert.equal(level, 1);
      players[p].count += level; players[p].value = 260;
    },
  };
  runInNewContext(`${js}\nConfigure();`, api);
  assert.deepEqual(players.map(p => p.count), [0, 0, 1, 0, 0, 1]);
  // Official startup Add happens later; a repeated callback cannot replay Set.
  for (const p of players) p.value += 40;
  runInNewContext(`${js}\nConfigure();`, api);
  assert.deepEqual(players.map(p => p.value), [140, 140, 300, 140, 140, 300]);
  assert.deepEqual(players.map(p => p.count), [0, 0, 1, 0, 0, 1]);
  const unscoped = commanderUpgradeGalaxy({ commanderId: 'ProtossKarax',
    upgradeId: 'GeneratedStat', configureFunction: 'Configure' });
  assert.doesNotMatch(unscoped, /prestige|PlayerPrestige/);
});

test("Map Runtime commits prestige selection before generated configuration, ahead of mission tech", async () => {
  const root = path.join(repositoryRoot, 'game-a/core/GameA.SC2Mod/Base.SC2Data');
  const core = await readFile(path.join(root, 'GameACore.galaxy'), 'utf8');
  const preparation = await readFile(path.join(root, 'Generated/PreparationOptions.galaxy'), 'utf8');
  const integration = await readFile(path.join(root, 'GameAIntegration.galaxy'), 'utf8');
  const configure = core.slice(core.indexOf('void GameA_ConfigureCommander'), core.indexOf('void GameA_ConfigureCommander') + 2600);
  assert(configure.indexOf('GameA_PreparationOptionsApply();') >= 0);
  assert(configure.indexOf('GameA_PreparationOptionsApply();') < configure.indexOf('GameA_GeneratedConfigureCommander();'));
  assert.match(preparation, /void GameA_PreparationOptionsApply \(\) \{\s*libCOOC_gf_CC_SetPlayerPrestigeIndex\(1, gameA_selectedPrestige\)/);
  assert.doesNotMatch(configure, /libCOOC_gf_CC_ApplyTech\(/);
  assert.match(integration, /libCOOC_gf_CC_ApplyTech\(player\)/);
  assert.doesNotMatch(integration, /GameA_GeneratedConfigureCommander\(/);
});

test("rejects C-style Galaxy array declarations before runtime", () => {
  assert.throws(
    () => validateGalaxySource("unit heroes[16];\n", "Generated/Hero.galaxy"),
    /Galaxy array dimensions belong after the type; use 'unit\[16\] heroes'/,
  );
  assert.doesNotThrow(() => validateGalaxySource("unit[16] heroes;\n", "Generated/Hero.galaxy"));
});

test("PatchPlan v2 schema accepts composable unit postconditions", async () => {
  const plan = {
    formatVersion: 2,
    id: "unit-command-postcondition-schema",
    title: "Validate a visible autocast command",
    userSummary: { text: "测试单位生命值 100 → 125。" },
    target: "game-a.core",
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
    scope: { kind: "commander", commanderId: "TestCommander" },
    isolation: { strategy: "player-upgrade" },
    operations: [
      {
        opId: "set-test-life",
        kind: "commander.stat.set",
        commanderId: "TestCommander",
        catalog: "Unit",
        object: "TestUnit",
        path: "LifeMax",
        expect: 100,
        value: 125,
      },
    ],
    postconditions: [
      {
        postId: "test-autocast",
        kind: "unit.autocast",
        unitId: "TestUnit",
        abilityId: "TestAbility",
        command: "Execute",
        buttonId: "TestAbilityButton",
        cardIndex: 0,
        row: 2,
        column: 0,
        requirementId: null,
        defaultOn: true,
      },
      {
        postId: "test-effect-chain",
        kind: "ability.effect-chain",
        abilityId: "TestAbility",
        effectPath: "Effect[0]",
        rootEffectId: "TestRootEffect",
        requiredEffectIds: ["TestDamageEffect"],
      },
      {
        postId: "test-localization",
        kind: "localization.present",
        entries: [
          {
            locale: "zhCN",
            key: "Button/Name/TestAbility",
            expected: "测试技能",
          },
          {
            locale: "enUS",
            key: "Button/Tooltip/TestAbility",
          },
        ],
      },
    ],
  };

  await validatePatchPlan(plan, schemaV2Path);
  await assert.rejects(
    validatePatchPlan({ ...plan, userSummary: { text: "第一行\n第二行" } }, schemaV2Path),
    (error) => error.message === "PatchPlan schema validation failed"
      && error.details.some((detail) => detail.includes("/userSummary/text must match pattern")),
  );
});

test("PatchPlan v2 schema accepts an explicit unit clone contract", async () => {
  const plan = {
    formatVersion: 2,
    id: "unit-clone-postcondition-schema",
    title: "Clone a commander unit completely",
    userSummary: { text: "为测试指挥官创建一个可生产的私有单位副本。" },
    target: "game-a.core",
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
    scope: { kind: "commander", commanderId: "TestCommander" },
    isolation: {
      strategy: "private-clone",
      owner: { catalog: "Unit", object: "SourceUnit" },
    },
    operations: [
      {
        opId: "clone-test-unit",
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
            path: "InfoArray[Train1].Unit",
            expect: "SourceUnit",
          },
        ],
      },
    ],
    postconditions: [
      {
        postId: "complete-unit-clone",
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
            path: "InfoArray[Train1].Unit",
          },
        ],
        requiredActorFields: ["UnitIcon", "Wireframe.Image", "PortraitModel", "StatusBarFlags[Life]"],
        vitalPolicy: "preserve-source",
        nameKey: "Unit/Name/SourceUnit",
      },
    ],
  };

  await validatePatchPlan(plan, schemaV2Path);
});

test("reports every Catalog target written by a commander unit clone", () => {
  const operation = {
    opId: "clone-tempest",
    kind: "commander.unit.clone",
    commanderId: "ProtossArtanis",
    sourceUnit: "Tempest",
    unitId: "GameAArtanisTempest",
    actorId: "GameAArtanisTempestActor",
    redirects: [
      {
        catalog: "Abil",
        object: "StargateTrain",
        path: "InfoArray[Train10].Unit",
      },
      {
        catalog: "Abil",
        object: "StargateWarpTrain",
        path: "InfoArray[Train10].Unit",
      },
    ],
  };

  assert.deepEqual(operationTargets(operation), [
    "commander/ProtossArtanis/unit/Tempest",
    "catalog/Unit/GameAArtanisTempest",
    "catalog/Actor/GameAArtanisTempestActor",
    "catalog/Abil/StargateTrain/InfoArray[Train10].Unit",
    "catalog/Abil/StargateWarpTrain/InfoArray[Train10].Unit",
  ]);
  assert.equal(operationTarget(operation), "commander/ProtossArtanis/unit/Tempest");
  assert.equal(
    targetsConflict(
      "catalog/Unit/GameAArtanisTempest",
      "catalog/Unit/GameAArtanisTempest/LifeMax",
    ),
    true,
  );
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createCore(root) {
  const core = path.join(root, "GameA.SC2Mod");
  const gameData = path.join(core, "Base.SC2Data", "GameData");
  await mkdir(gameData, { recursive: true });
  await writeFile(
    path.join(core, "Base.SC2Data", "GameData.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<Includes>
    <Catalog path="GameData/AbilData.xml"/>
    <Catalog path="GameData/EffectData.xml"/>
</Includes>
`,
  );
  await writeFile(
    path.join(gameData, "AbilData.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CAbilEffectTarget id="TestAbility">
        <Cost index="0"><Resource index="Minerals" value="0"/></Cost>
    </CAbilEffectTarget>
</Catalog>
`,
  );
  await writeFile(
    path.join(gameData, "EffectData.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CEffectSet id="TestEffect"><EffectArray index="1" value="TimedLife"/></CEffectSet>
</Catalog>
`,
  );
  await writeFile(
    path.join(core, "GameA.Core.json"),
    `${JSON.stringify({ schemaVersion: 1, galaxy: { modules: [], core: "Base.SC2Data/GameACore.galaxy" }, copyRoots: [] }, null, 2)}\n`,
  );
  await writeFile(path.join(core, "Base.SC2Data", "GameACore.galaxy"), "void GameA_Init () {}\n");
  await mkdir(path.join(core, "enUS.SC2Data", "LocalizedData"), { recursive: true });
  await writeFile(
    path.join(core, "enUS.SC2Data", "LocalizedData", "GameStrings.txt"),
    "Test/Label=Old\n",
  );
  await writeFile(path.join(core, "notes.txt"), "alpha\nold\nomega\n");
  return core;
}

function planWithAllOperations(notesHash) {
  return {
    formatVersion: 1,
    id: "executor-all-operations",
    title: "Executor all operations",
    target: "game-a.core",
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
    operations: [
      {
        opId: "set-cost",
        kind: "catalog.set",
        catalog: "Abil",
        object: "TestAbility",
        path: "Cost[0].Resource[Minerals]",
        expect: 0,
        value: 25,
      },
      {
        opId: "remove-effect",
        kind: "catalog.remove",
        catalog: "Effect",
        object: "TestEffect",
        path: "EffectArray[1]",
        expect: "TimedLife",
      },
      {
        opId: "write-module",
        kind: "galaxy.source",
        path: "Base.SC2Data/Generated/ExecutorTest.galaxy",
        source: "void GameA_ExecutorTestInit () {}\n",
        register: { order: 250, init: "GameA_ExecutorTestInit" },
      },
      {
        opId: "set-label",
        kind: "locale.set",
        locale: "enUS",
        key: "Test/Label",
        expect: "Old",
        value: "New",
      },
      {
        opId: "patch-notes",
        kind: "file.patch",
        path: "notes.txt",
        baseSha256: notesHash,
        patch: "@@ -1,3 +1,3 @@\n alpha\n-old\n+new\n omega\n",
      },
    ],
  };
}

test("applies all PatchPlan v1 operations and is idempotent", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-executor-test-"));
  try {
    const core = await createCore(temporary);
    const plan = planWithAllOperations(hash("alpha\nold\nomega\n"));
    await validatePatchPlan(plan, schemaPath);

    const first = await applyPlanToCore({ coreRoot: core, plan });
    assert.equal(first.results.filter((result) => result.status === "changed").length, 5);
    assert.match(await readFile(path.join(core, "Base.SC2Data", "GameData", "AbilData.xml"), "utf8"), /Resource index="Minerals" value="25"/);
    assert.match(await readFile(path.join(core, "Base.SC2Data", "GameData", "EffectData.xml"), "utf8"), /EffectArray index="1" removed="1"/);
    assert.equal(await readFile(path.join(core, "Base.SC2Data", "Generated", "ExecutorTest.galaxy"), "utf8"), "void GameA_ExecutorTestInit () {}\n");
    assert.match(await readFile(path.join(core, "GameA.Core.json"), "utf8"), /GameA_ExecutorTestInit/);
    assert.equal(await readFile(path.join(core, "enUS.SC2Data", "LocalizedData", "GameStrings.txt"), "utf8"), "Test/Label=New\n");
    assert.equal(await readFile(path.join(core, "notes.txt"), "utf8"), "alpha\nnew\nomega\n");

    const second = await applyPlanToCore({ coreRoot: core, plan });
    assert.equal(second.results.every((result) => result.status === "already"), true);
    assert.deepEqual(second.changedFiles, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("uses the parsed Catalog root to create an override with the official XML class", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-catalog-test-"));
  try {
    const core = await createCore(path.join(temporary, "core"));
    const catalogRoot = path.join(temporary, "database", "GameData");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(
      path.join(catalogRoot, "UnitData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog><CUnit id="TestMarine"><LifeMax value="45"/></CUnit></Catalog>
`,
    );
    const plan = {
      formatVersion: 1,
      id: "database-class-resolution",
      title: "Database class resolution",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "set-life",
          kind: "catalog.set",
          catalog: "Unit",
          object: "TestMarine",
          path: "LifeMax",
          expect: 45,
          value: 55,
        },
      ],
    };
    await validatePatchPlan(plan, schemaPath);
    await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    const unitXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "UnitData.xml"), "utf8");
    assert.match(unitXml, /<CUnit id="TestMarine">/);
    assert.match(unitXml, /<LifeMax value="55"\/>/);
    assert.match(await readFile(path.join(core, "Base.SC2Data", "GameData.xml"), "utf8"), /GameData\/UnitData\.xml/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("uses Catalog class defaults when checking effective field preconditions", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-catalog-default-test-"));
  try {
    const core = await createCore(path.join(temporary, "core"));
    const catalogRoot = path.join(temporary, "database", "GameData");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(
      path.join(catalogRoot, "UnitData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CUnit default="1"><Radius value="0.5"/></CUnit>
    <CUnit id="DefaultMarine"/>
</Catalog>
`,
    );
    const plan = {
      formatVersion: 1,
      id: "database-class-default-resolution",
      title: "Database class default resolution",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [{
        opId: "set-radius",
        kind: "catalog.set",
        catalog: "Unit",
        object: "DefaultMarine",
        path: "Radius",
        expect: 0.5,
        value: 0.75,
      }],
    };

    const first = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(first.results[0].status, "changed");
    const second = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(second.results[0].status, "already");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("edits an ability Cost member inherited from an unindexed positional record", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-ability-cost-test-"));
  try {
    const core = await createCore(path.join(temporary, "core"));
    const catalogRoot = path.join(temporary, "database", "GameData");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(path.join(catalogRoot, "AbilData.xml"), `<?xml version="1.0" encoding="utf-8"?>
<Catalog><CAbilEffectTarget id="Orb"><Cost><Vital index="Energy" value="50"/>
  <Cooldown TimeUse="2"/></Cost><Cost index="0"><Vital index="Energy" value="100"/></Cost></CAbilEffectTarget></Catalog>
`);
    const plan = {
      formatVersion: 1,
      id: "ability-cost-positional-overlay",
      title: "Ability Cost positional overlay",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [{ opId: "set-cooldown", kind: "catalog.set", catalog: "Abil", object: "Orb",
        path: "Cost[0].Cooldown.@TimeUse", expect: 2, value: 6 }],
    };

    const first = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(first.results[0].status, "changed");
    const abilityXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "AbilData.xml"), "utf8");
    assert.match(abilityXml, /<CAbilEffectTarget id="Orb">\s*<Cost index="0">\s*<Cooldown TimeUse="6"\/>/);
    assert.doesNotMatch(abilityXml, /<Vital/, "the partial override must not copy or replace the energy member");
    const second = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(second.results[0].status, "already");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("does not modify the real core when a later operation fails", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-atomic-test-"));
  try {
    const repo = path.join(temporary, "repo");
    const core = await createCore(path.join(repo, "game-a", "core"));
    await mkdir(path.join(repo, "docs", "schemas"), { recursive: true });
    await cp(schemaPath, path.join(repo, "docs", "schemas", "patch-plan.schema.json"));
    await writeFile(
      path.join(repo, "game-a", "runtime-baseline.json"),
      `${JSON.stringify({ schemaVersion: 2, sc2: { dataBuild: "B97579" } }, null, 2)}\n`,
    );
    const plan = {
      formatVersion: 1,
      id: "atomic-failure",
      title: "Atomic failure",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "first-change",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          expect: "Old",
          value: "Changed",
        },
        {
          opId: "later-conflict",
          kind: "catalog.set",
          catalog: "Abil",
          object: "TestAbility",
          path: "Cost[0].Resource[Minerals]",
          expect: 999,
          value: 25,
        },
      ],
    };
    const planPath = path.join(repo, "plan.patch-plan.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    await assert.rejects(
      executePatchPlan({ repoRoot: repo, planPath, runGameAValidation: false }),
      /expected 999, found "0"/,
    );
    assert.equal(await readFile(path.join(core, "enUS.SC2Data", "LocalizedData", "GameStrings.txt"), "utf8"), "Test/Label=Old\n");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("atomically installs a successful core and records the applied plan", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-commit-test-"));
  try {
    const repo = path.join(temporary, "repo");
    const core = await createCore(path.join(repo, "game-a", "core"));
    await mkdir(path.join(repo, "docs", "schemas"), { recursive: true });
    await cp(schemaPath, path.join(repo, "docs", "schemas", "patch-plan.schema.json"));
    await writeFile(
      path.join(repo, "game-a", "runtime-baseline.json"),
      `${JSON.stringify({ schemaVersion: 2, sc2: { dataBuild: "B97579" } }, null, 2)}\n`,
    );
    const plan = {
      formatVersion: 1,
      id: "atomic-success",
      title: "Atomic success",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "change-label",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          expect: "Old",
          value: "Installed",
        },
      ],
    };
    const planPath = path.join(repo, "plan.patch-plan.json");
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const untouchedCatalog = path.join(core, "Base.SC2Data", "GameData", "AbilData.xml");
    const untouchedBefore = await stat(untouchedCatalog);

    const report = await executePatchPlan({
      repoRoot: repo,
      planPath,
      runGameAValidation: false,
    });
    assert.equal(report.planRecorded, true);
    assert.equal(await readFile(path.join(core, "enUS.SC2Data", "LocalizedData", "GameStrings.txt"), "utf8"), "Test/Label=Installed\n");
    const untouchedAfter = await stat(untouchedCatalog);
    assert.equal(untouchedAfter.mtimeMs, untouchedBefore.mtimeMs);
    const recorded = JSON.parse(
      await readFile(path.join(repo, "game-a", "patches", "atomic-success.patch-plan.json"), "utf8"),
    );
    assert.equal(recorded.$schema, "../../docs/schemas/patch-plan.schema.json");
    assert.equal(recorded.id, "atomic-success");
    const receipt = JSON.parse(
      await readFile(path.join(repo, "game-a", "patches", "atomic-success.receipt.json"), "utf8"),
    );
    assert.equal(receipt.planId, "atomic-success");
    assert.equal(receipt.operations[0].target, "locale/enUS/Test/Label");
    assert.deepEqual(receipt.operations[0].targets, ["locale/enUS/Test/Label"]);
    assert.match(receipt.planSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(receipt.coreTreeBeforeSha256, receipt.coreTreeAfterSha256);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan v2 creates, clones, inserts, and clears Catalog structures", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-v2-catalog-test-"));
  try {
    const core = await createCore(path.join(temporary, "core"));
    const catalogRoot = path.join(temporary, "database", "GameData");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(
      path.join(catalogRoot, "UnitData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CUnit id="BaseMarine">
        <LifeMax value="45"/>
        <AbilArray index="Move" Link="Move"/>
        <CardLayouts index="0"><LayoutButtons index="0" Face="Move"/></CardLayouts>
    </CUnit>
</Catalog>
`,
    );
    const plan = {
      formatVersion: 2,
      id: "v2-catalog-structures",
      title: "V2 Catalog structures",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "create-fresh-unit",
          kind: "catalog.create",
          catalog: "Unit",
          object: "FreshUnit",
          class: "CUnit",
        },
        {
          opId: "set-fresh-life",
          kind: "catalog.set",
          catalog: "Unit",
          object: "FreshUnit",
          path: "LifeMax",
          value: 100,
        },
        {
          opId: "insert-fresh-ability",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "FreshUnit",
          path: "AbilArray",
          index: "TestAbility",
          attributes: { Link: "TestAbility" },
        },
        {
          opId: "clone-marine",
          kind: "catalog.clone",
          catalog: "Unit",
          source: "BaseMarine",
          object: "ClonedMarine",
        },
        {
          opId: "insert-clone-ability",
          kind: "catalog.insert",
          catalog: "Unit",
          object: "ClonedMarine",
          path: "AbilArray",
          index: "ExtraAbility",
          attributes: { Link: "ExtraAbility" },
        },
        {
          opId: "set-clone-life",
          kind: "catalog.set",
          catalog: "Unit",
          object: "ClonedMarine",
          path: "LifeMax",
          expect: 45,
          value: 75,
        },
        {
          opId: "clear-clone-command-card",
          kind: "catalog.clear",
          catalog: "Unit",
          object: "ClonedMarine",
          path: "CardLayouts[0].LayoutButtons",
        },
      ],
    };
    await validatePatchPlan(plan, schemaV2Path);
    const first = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(first.results.every((result) => result.status === "changed"), true);
    const unitXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "UnitData.xml"), "utf8");
    assert.match(unitXml, /<CUnit id="FreshUnit">/);
    assert.match(unitXml, /<LifeMax value="100"\/>/);
    assert.match(unitXml, /<AbilArray index="TestAbility" Link="TestAbility"\/>/);
    assert.match(unitXml, /<CUnit id="ClonedMarine" parent="BaseMarine">/);
    assert.match(unitXml, /<AbilArray index="ExtraAbility" Link="ExtraAbility"\/>/);
    assert.match(unitXml, /<LifeMax value="75"\/>/);
    assert.match(unitXml, /<LayoutButtons index="0" removed="1"\/>/);

    const second = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(second.results.every((result) => result.status === "already"), true);
    assert.deepEqual(second.changedFiles, []);

  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan v2 prepares commander-scoped stats and unit clones without changing shared objects", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-commander-tools-test-"));
  try {
    const core = await createCore(path.join(temporary, "core"));
    const catalogRoot = path.join(temporary, "database", "GameData");
    await mkdir(catalogRoot, { recursive: true });
    await writeFile(
      path.join(catalogRoot, "UnitData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CUnit id="Tempest"><Name value="Unit/Name/##id##"/><LifeMax value="300"/></CUnit>
</Catalog>
`,
    );
    await writeFile(
      path.join(catalogRoot, "AbilData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CAbilTrain id="StargateTrain">
        <InfoArray index="Train10"><Unit value="Tempest"/></InfoArray>
    </CAbilTrain>
    <CAbilWarpTrain id="StargateWarpTrain">
        <InfoArray index="Train10"/>
    </CAbilWarpTrain>
</Catalog>
`,
    );
    await writeFile(
      path.join(catalogRoot, "ActorData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CActorUnit id="Tempest" parent="GenericUnitStandard" unitName="Tempest">
        <UnitIcon value="Assets\\Textures\\tempest.dds"/>
    </CActorUnit>
</Catalog>
`,
    );
    await writeFile(
      path.join(catalogRoot, "ModelData.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<Catalog>
    <CModel id="Tempest"><Model value="Assets\\Units\\Tempest.m3"/></CModel>
</Catalog>
`,
    );
    const plan = {
      formatVersion: 2,
      id: "commander-high-level-tools",
      title: "Commander high-level tools",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "set-artanis-tempest-life",
          kind: "commander.stat.set",
          commanderId: "ProtossArtanis",
          catalog: "Unit",
          object: "Tempest",
          path: "LifeMax",
          expect: 300,
          value: 450,
        },
        {
          opId: "clone-artanis-tempest",
          kind: "commander.unit.clone",
          commanderId: "ProtossArtanis",
          sourceUnit: "Tempest",
          unitId: "GameAArtanisTempest",
          redirects: [
            {
              catalog: "Abil",
              object: "StargateTrain",
              path: "InfoArray[Train10].Unit[0]",
              expect: "Tempest",
            },
            {
              catalog: "Abil",
              object: "StargateWarpTrain",
              path: "InfoArray[Train10].Unit",
              expectAbsent: true,
            },
          ],
        },
      ],
    };
    await validatePatchPlan(plan, schemaV2Path);

    const first = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(first.results.every((result) => result.status === "changed"), true);
    assert.deepEqual(first.results[1].targets, [
      "commander/ProtossArtanis/unit/Tempest",
      "catalog/Unit/GameAArtanisTempest",
      "catalog/Actor/GameAArtanisTempest",
      "catalog/Abil/StargateTrain/InfoArray[Train10].Unit[0]",
      "catalog/Abil/StargateWarpTrain/InfoArray[Train10].Unit",
    ]);
    const unitXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "UnitData.xml"), "utf8");
    assert.match(unitXml, /<CUnit id="GameAArtanisTempest" parent="Tempest">/);
    assert.match(unitXml, /<Name value="Unit\/Name\/Tempest"\/>/);
    assert.doesNotMatch(unitXml, /<LifeMax/);
    const actorXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "ActorData.xml"), "utf8");
    assert.match(actorXml, /<CActorUnit id="GameAArtanisTempest" parent="GenericUnitStandard" unitName="GameAArtanisTempest">/);
    assert.match(actorXml, /<UnitIcon value="Assets\\Textures\\tempest\.dds"\/>/);
    assert.match(actorXml, /<Model value="Tempest"\/>/);
    const upgradeXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "UpgradeData.xml"), "utf8");
    assert.match(upgradeXml, /Reference="Unit,Tempest,LifeMax" Value="450"/);
    assert.match(upgradeXml, /Reference="Abil,StargateTrain,InfoArray\[Train10\]\.Unit\[0\]" Value="GameAArtanisTempest"/);
    assert.match(upgradeXml, /Reference="Abil,StargateWarpTrain,InfoArray\[Train10\]\.Unit" Value="GameAArtanisTempest"/);
    const manifest = JSON.parse(await readFile(path.join(core, "GameA.Core.json"), "utf8"));
    const commanderModules = manifest.galaxy.modules.filter((module) => module.configure);
    assert.equal(commanderModules.length, 2);
    assert.equal(commanderModules.every((module) => module.order === 300), true);
    for (const module of commanderModules) {
      const source = await readFile(path.join(core, ...module.path.split("/")), "utf8");
      assert.match(source, /ActiveCommanderForPlayer\(player\) == "ProtossArtanis"/);
      assert.match(source, /TechTreeUpgradeAddLevel/);
    }

    const second = await applyPlanToCore({ coreRoot: core, plan, catalogRoot });
    assert.equal(second.results.every((result) => result.status === "already"), true);
    assert.deepEqual(second.changedFiles, []);

    const revision = {
      formatVersion: 2,
      id: "revise-commander-stat",
      title: "Revise commander stat",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "revise-artanis-tempest-life",
          kind: "commander.stat.set",
          commanderId: "ProtossArtanis",
          catalog: "Unit",
          object: "Tempest",
          path: "LifeMax",
          expect: 450,
          value: 500,
        },
      ],
    };
    await validatePatchPlan(revision, schemaV2Path);
    const revised = await applyPlanToCore({ coreRoot: core, plan: revision, catalogRoot });
    assert.equal(revised.results[0].status, "changed");
    const revisedUpgradeXml = await readFile(path.join(core, "Base.SC2Data", "GameData", "UpgradeData.xml"), "utf8");
    assert.equal((revisedUpgradeXml.match(/Reference="Unit,Tempest,LifeMax"/g) ?? []).length, 1);
    assert.match(revisedUpgradeXml, /Reference="Unit,Tempest,LifeMax" Value="500"/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("PatchPlan v2 enforces dependencies and explicit conflicts", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "coopagent-v2-relations-test-"));
  try {
    const repo = path.join(temporary, "repo");
    const core = await createCore(path.join(repo, "game-a", "core"));
    await mkdir(path.join(repo, "docs", "schemas"), { recursive: true });
    await cp(schemaPath, path.join(repo, "docs", "schemas", "patch-plan.schema.json"));
    await cp(schemaV2Path, path.join(repo, "docs", "schemas", "patch-plan-v2.schema.json"));
    await writeFile(
      path.join(repo, "game-a", "runtime-baseline.json"),
      `${JSON.stringify({ schemaVersion: 2, sc2: { dataBuild: "B97579" } }, null, 2)}\n`,
    );
    const basePlan = {
      formatVersion: 2,
      id: "base-change",
      title: "Base change",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "base-label",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          expect: "Old",
          value: "Base",
        },
      ],
    };
    const dependentPlan = {
      formatVersion: 2,
      id: "dependent-change",
      title: "Dependent change",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      dependsOn: ["base-change"],
      operations: [
        {
          opId: "dependent-label",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          expect: "Base",
          value: "Dependent",
        },
      ],
    };
    const conflictingPlan = {
      formatVersion: 2,
      id: "conflicting-change",
      title: "Conflicting change",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      conflictsWith: ["base-change"],
      operations: [
        {
          opId: "conflicting-label",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          value: "Conflict",
        },
      ],
    };
    const implicitConflictPlan = {
      formatVersion: 2,
      id: "implicit-conflict",
      title: "Implicit conflict",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "same-label-target",
          kind: "locale.set",
          locale: "enUS",
          key: "Test/Label",
          value: "Implicit conflict",
        },
      ],
    };
    const cloneTargetConflictPlan = {
      formatVersion: 2,
      id: "clone-target-conflict",
      title: "Clone target conflict",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "change-cloned-unit",
          kind: "catalog.set",
          catalog: "Unit",
          object: "GameAArtanisTempest",
          path: "LifeMax",
          value: 500,
        },
      ],
    };
    const legacyReceiptConflictPlan = {
      formatVersion: 2,
      id: "legacy-receipt-conflict",
      title: "Legacy receipt conflict",
      target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      operations: [
        {
          opId: "change-legacy-label",
          kind: "locale.set",
          locale: "enUS",
          key: "Legacy/Label",
          value: "Conflict",
        },
      ],
    };
    for (const plan of [
      basePlan,
      dependentPlan,
      conflictingPlan,
      implicitConflictPlan,
      cloneTargetConflictPlan,
      legacyReceiptConflictPlan,
    ]) {
      plan.scope = { kind: "global" };
      plan.isolation = { strategy: "global" };
      await writeFile(path.join(repo, `${plan.id}.json`), `${JSON.stringify(plan, null, 2)}\n`);
    }
    await executePatchPlan({
      repoRoot: repo,
      planPath: path.join(repo, "base-change.json"),
      runGameAValidation: false,
    });
    await executePatchPlan({
      repoRoot: repo,
      planPath: path.join(repo, "dependent-change.json"),
      runGameAValidation: false,
    });
    assert.equal(await readFile(path.join(core, "enUS.SC2Data", "LocalizedData", "GameStrings.txt"), "utf8"), "Test/Label=Dependent\n");
    await assert.rejects(
      executePatchPlan({
        repoRoot: repo,
        planPath: path.join(repo, "conflicting-change.json"),
        runGameAValidation: false,
      }),
      /Conflicting PatchPlan 'base-change' is already applied/,
    );
    await assert.rejects(
      executePatchPlan({
        repoRoot: repo,
        planPath: path.join(repo, "implicit-conflict.json"),
        runGameAValidation: false,
      }),
      /target 'locale\/enUS\/Test\/Label' conflicts with applied plan 'base-change'/,
    );
    await writeFile(
      path.join(repo, "game-a", "patches", "clone-write.receipt.json"),
      `${JSON.stringify({
        receiptVersion: 1,
        planId: "clone-write",
        operations: [
          {
            opId: "clone-tempest",
            kind: "commander.unit.clone",
            target: "commander/ProtossArtanis/unit/Tempest",
            targets: [
              "commander/ProtossArtanis/unit/Tempest",
              "catalog/Unit/GameAArtanisTempest",
              "catalog/Actor/GameAArtanisTempest",
              "catalog/Abil/StargateTrain/InfoArray[Train10].Unit",
            ],
          },
        ],
      }, null, 2)}\n`,
    );
    await assert.rejects(
      executePatchPlan({
        repoRoot: repo,
        planPath: path.join(repo, "clone-target-conflict.json"),
        runGameAValidation: false,
      }),
      /target 'catalog\/Unit\/GameAArtanisTempest\/LifeMax' conflicts with applied plan 'clone-write' at 'catalog\/Unit\/GameAArtanisTempest'/,
    );
    await writeFile(
      path.join(repo, "game-a", "patches", "legacy-write.receipt.json"),
      `${JSON.stringify({
        receiptVersion: 1,
        planId: "legacy-write",
        operations: [
          {
            opId: "legacy-label",
            kind: "locale.set",
            target: "locale/enUS/Legacy/Label",
          },
        ],
      }, null, 2)}\n`,
    );
    await assert.rejects(
      executePatchPlan({
        repoRoot: repo,
        planPath: path.join(repo, "legacy-receipt-conflict.json"),
        runGameAValidation: false,
      }),
      /target 'locale\/enUS\/Legacy\/Label' conflicts with applied plan 'legacy-write'/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
