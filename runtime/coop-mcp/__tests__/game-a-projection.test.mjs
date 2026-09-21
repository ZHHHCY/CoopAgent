import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildCascDatabase } from "../../../scripts/lib/casc-database-builder.mjs";
import { executePatchPlan, commanderStatIdentity, applyPlanToCore, treeHash } from "../../../scripts/lib/patch-plan-executor.mjs";
import { auditPatchArtifacts } from "../../../scripts/lib/patch-plan-artifact-audit.mjs";
import { openGameAArtifacts } from "../lib/game-a-artifacts.mjs";
import { acquireGameALock } from "../../../scripts/lib/game-a-transaction.mjs";
import { createCoopSearch } from "../lib/coop-search.mjs";
import { executeScalarSearch } from '../lib/scalar-search-view.mjs';
import { buildUnitProjection } from "../lib/unit-details.mjs";
import { reviewPatchPlan } from "../lib/patch-plan-review.mjs";
import { importEngineCatalog } from "../../../scripts/lib/engine-catalog-store.mjs";
import { OFFICIAL_DEPENDENCY } from "../../../scripts/lib/sc2-catalog-probe.mjs";
import { createCoopAgentCore } from '../lib/coop-agent-core.mjs';
import { solveScalar, checkScalarCalculations } from '../lib/scalar-solve.mjs';
import { resolveUpgradeOperation } from '../lib/upgrade-operation.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function write(root, relative, value) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}
function fixture(t, extraCatalogFiles = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "coop-current-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo");
  const coreRoot = path.join(repoRoot, "game-a/core/GameA.SC2Mod");
  const cascRoot = path.join(root, "casc/B97579");
  const data = "files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata";
  write(cascRoot, "manifest.json", { source: { version: "synthetic-test" } });
  write(cascRoot, `${data}/unitdata.xml`, `<Catalog>
    <CUnit default="1"><Name value="Unit/Name/##id##"/><LifeMax value="10"/><Speed value="2"/></CUnit>
    <CUnit id="Dragoon"><LifeMax value="100"/><LifeStart value="100"/>
      <AbilArray Link="Move"/><AbilArray Link="OldSkill"/><AbilArray Link="Attack"/>
      <CardLayouts><LayoutButtons Face="Move" AbilCmd="Move,Execute" Row="0" Column="0"/>
        <LayoutButtons Face="OldSkill" AbilCmd="OldSkill,Execute" Row="2" Column="0"/>
        <LayoutButtons Face="Attack" AbilCmd="Attack,Execute" Row="0" Column="4"/></CardLayouts>
    </CUnit>
    <CUnit id="DragoonChild" parent="Dragoon"/>
    <CUnit id="Tempest"><LifeMax value="300"/><LifeStart value="300"/><ShieldsMax value="150"/>
      <WeaponArray index="0" Link="TestWeapon"/><WeaponArray index="1" Link="TestAirWeapon"/>
    </CUnit>
  </Catalog>`);
  write(cascRoot, `${data}/abildata.xml`, `<Catalog>
    <CAbilEffectInstant id="OldSkill"><Effect value="OldEffect"/></CAbilEffectInstant>
    <CAbilMove id="Move"/><CAbilAttack id="Attack"/>
    <CAbilTrain id="TestTrain"><InfoArray index="Train8"><Unit value="Tempest"/></InfoArray></CAbilTrain>
  </Catalog>`);
  write(cascRoot, `${data}/actordata.xml`, '<Catalog><CActorUnit id="Tempest" unitName="Tempest"><Model value="Tempest"/></CActorUnit></Catalog>');
  write(cascRoot, `${data}/modeldata.xml`, '<Catalog><CModel id="Tempest"><Model value="Assets/TestShip.m3"/></CModel></Catalog>');
  write(cascRoot, `${data}/effectdata.xml`, '<Catalog><CEffectDamage id="OldEffect"><Amount value="10"/></CEffectDamage></Catalog>');
  write(cascRoot, `${data}/weapondata.xml`, '<Catalog><CWeaponLegacy id="TestWeapon"><Period value="1.5"/><Effect value="OldEffect"/></CWeaponLegacy><CWeaponLegacy id="TestAirWeapon"><Period value="2"/><Effect value="OldEffect"/></CWeaponLegacy></Catalog>');
  write(cascRoot, `${data}/upgradedata.xml`, '<Catalog><CUpgrade id="ExampleUpgrade"/><CUpgrade id="TestWeaponUpgrade"><EffectArray Reference="Weapon,TestWeapon,Period" Operation="Multiply" Value="0.9"/></CUpgrade><CUpgrade id="UnchangedAirUpgrade"><EffectArray Reference="Weapon,TestAirWeapon,Period" Operation="Multiply" Value="0.9"/></CUpgrade></Catalog>');
  write(cascRoot, `${data}/userdata.xml`, '<Catalog><CUser id="MasteryUpgrades"><Instances Id="ArtanisMastery1"><Fixed Fixed="3"><Field Id="PointIncrement"/></Fixed><User Type="PlayerCommanders" Instance="ProtossArtanis"><Field Id="Commander"/></User></Instances><Instances Id="OtherMastery"><Fixed Fixed="7"><Field Id="PointIncrement"/></Fixed></Instances></CUser></Catalog>');
  write(cascRoot, `${data}/commanderdata.xml`, '<Catalog><CCommander id="Artanis"><MasteryTalentArray Talent="TestWeaponUpgrade" ValuePerRank="3" MaxRank="30"/><MasteryTalentArray><Talent value="OtherMastery"/><ValuePerRank value="7"/><MaxRank value="30"/></MasteryTalentArray></CCommander></Catalog>');
  write(cascRoot, "files/mods/core.sc2mod/zhcn.sc2data/localizeddata/gamestrings.txt", "Unit/Name/Dragoon=龙骑士\nUnit/Name/Tempest=风暴战舰\n");
  for(const [name,xml] of Object.entries(extraCatalogFiles))write(cascRoot,`${data}/${name}`,xml);
  const { databaseFile } = buildCascDatabase({ cascRoot, output: path.join(root, "db") });
  const database = new DatabaseSync(databaseFile);
  for (const [id, objectId] of [["ProtossArtanis", "Artanis"], ["TerranRaynor", "Raynor"]]) {
    database.prepare(`INSERT INTO commanders
      (id,commander_object_id,user_reference,name_key,name_zhcn,name_enus) VALUES (?,?,?,?,?,?)`)
      .run(id, objectId, id, id, objectId, objectId);
    database.prepare("INSERT INTO commander_profiles VALUES (?,?)").run(id, JSON.stringify({
      roster: { units: [{ techId: "Dragoon", unitId: "Dragoon" }], buildings: [] },
      levelPerks: [], prestiges: [{ index: 1, id: 'ExampleUpgrade' }], masteries: [], panel: { abilityCommands: [], defaultUpgrades: [] },
    }));
  }
  database.close();
  write(repoRoot, "game-a/runtime-baseline.json", { schemaVersion: 2, sc2: { dataBuild: "B97579" } });
  write(coreRoot, "Base.SC2Data/GameData.xml", "<Includes/>");
  write(coreRoot, "GameA.Core.json", { galaxy: { modules: [] } });
  mkdirSync(path.join(coreRoot, "Base.SC2Data/GameData"), { recursive: true });
  cpSync(path.join(repository, "docs/schemas"), path.join(repoRoot, "docs/schemas"), { recursive: true });
  const options = { repoRoot, databaseFile };
  const search = (extra={}) => createCoopSearch({...options,...extra});
  const get = (objectId = "Dragoon", fieldPath = "LifeMax", commanderId = "Artanis") =>
    search().execute({ operation: "entity.get", catalog: "Unit", objectId, path: fieldPath, commanderId, limit: 100, detailLevel: "full" });
  async function apply(id, operations, dependsOn = [], overrides = {}) {
    const plan = { formatVersion: 2, id, title: id, target: "game-a.core",
      compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
      scope: { kind: "commander", commanderId: "ProtossArtanis" }, isolation: { strategy: "player-upgrade" },
      operations, dependsOn, ...overrides };
    write(repoRoot, `${id}.patch-plan.json`, plan);
    return executePatchPlan({ repoRoot, planPath: `${id}.patch-plan.json`,
      catalogRoot: path.join(root, "db/merged/GameData"), runGameAValidation: false });
  }
  function catalog(contents) {
    write(coreRoot, "Base.SC2Data/GameData.xml", `<Includes>${Object.keys(contents).map((name) =>
      `<Catalog path="GameData/${name}Data.xml"/>`).join("")}</Includes>`);
    for (const [name, value] of Object.entries(contents)) write(coreRoot, `Base.SC2Data/GameData/${name}Data.xml`, `<Catalog>${value}</Catalog>`);
  }
  return { repoRoot, coreRoot, databaseFile, search, get, apply, catalog };
}

test('read snapshots reuse data, invalidate same-size external edits and preserve scope and continuous commits',async t=>{
  const f=fixture(t),search=f.search({reuseSnapshots:true});
  const read=(commanderId='ProtossArtanis',prestigeUpgrade)=>search.execute({operation:'entity.get',catalog:'Unit',objectId:'Dragoon',path:'LifeMax',commanderId,...(prestigeUpgrade?{prestigeUpgrade}:{})});
  try {
    assert.equal(read().editState.edit.expect,100);assert.equal(read().editState.edit.expect,100);
    assert.equal(search.metrics().cache.hits,1);
    assert.equal(read('TerranRaynor').currentProject.commanderId,'TerranRaynor');
    f.catalog({Unit:'<CUnit id="Dragoon"><LifeMax value="110"/></CUnit>'});
    assert.equal(read().editState.edit.expect,110);
    const file=path.join(f.coreRoot,'Base.SC2Data/GameData/UnitData.xml'),stat=statSync(file);
    writeFileSync(file,readFileSync(file,'utf8').replace('110','120'));utimesSync(file,stat.atime,stat.mtime);
    assert.equal(read().editState.edit.expect,120,'same-size and restored timestamp still invalidates');
    await f.apply('cached-conditional',[{opId:'life',kind:'commander.stat.set',commanderId:'ProtossArtanis',prestigeUpgrade:'ExampleUpgrade',catalog:'Unit',object:'Dragoon',path:'LifeMax',expect:120,value:150}]);
    const scoped=read('ProtossArtanis','ExampleUpgrade');
    assert.equal(scoped.editState.edit.expect,150);assert.deepEqual(scoped.editState.edit.requiredDependsOn,['cached-conditional']);
    assert.equal(read().editState.edit.expect,120);assert.equal(read('TerranRaynor','ExampleUpgrade').editState.edit.expect,120);
    const db=new DatabaseSync(f.databaseFile);
    db.prepare('UPDATE catalog_fields SET value=? WHERE catalog=? AND object_id=? AND path=?').run('4','Unit','Tempest','Speed');db.close();
    const updated=search.execute({operation:'entity.get',catalog:'Unit',objectId:'Tempest',path:'Speed',commanderId:'ProtossArtanis'});
    assert.equal(updated.editState.coreCatalog.value,4,'official DB writes invalidate existing connections');
    const release=acquireGameALock(f.repoRoot);
    try {assert.throws(()=>read(),/正在预检|project-busy/);}finally{release();}
  }finally{search.close();}
});

test('upgrade Reference filtering returns current editable operands and respects retargeting and dependencies',async t=>{
  const f=fixture(t),search=f.search();
  const input={operation:'entity.get',catalog:'Upgrade',objectId:'TestWeaponUpgrade',commanderId:'ProtossArtanis',topic:'upgradeEffects',reference:{catalog:'Weapon',objectId:'TestWeapon',path:'Period'}};
  const first=executeScalarSearch(search,input).upgradeEffects;
  assert.equal(first.total,1);assert.equal(first.effects[0].operation,'Multiply');assert.equal(first.effects[0].edit.expect,0.9);
  await f.apply('filtered-operand',[{...first.effects[0].edit.operation,opId:'operand',expect:0.9,value:0.8}],[],{isolation:{strategy:'direct-private',owner:{catalog:'Upgrade',object:'TestWeaponUpgrade'}}});
  const updated=executeScalarSearch(search,input).upgradeEffects;
  assert.equal(updated.effects[0].edit.available,true,JSON.stringify(updated.effects[0]));
  assert.equal(updated.effects[0].edit.expect,0.8);assert.deepEqual(updated.effects[0].edit.requiredDependsOn,['filtered-operand']);
  f.catalog({Upgrade:'<CUpgrade id="TestWeaponUpgrade"><EffectArray index="0" Reference="Weapon,TestAirWeapon,Period" Value="0.8"/></CUpgrade>'});
  assert.equal(executeScalarSearch(search,input).upgradeEffects.total,0);
  assert.equal(executeScalarSearch(search,{...input,reference:{catalog:'Weapon',objectId:'TestAirWeapon'}}).upgradeEffects.total,1);
  assert.throws(()=>executeScalarSearch(search,{...input,topic:'parameters'}),/reference requires/);
});

test('upgrade operation semantics distinguish engine defaults, explicit values and unresolved omission',t=>{
  const path='EffectArray[0].@Operation';
  assert.deepEqual(resolveUpgradeOperation({path,projected:{path,value:'Add',source_file:'engine:s1'}}).effective,
    {status:'resolved',value:'Add',basis:'sc2-engine-resolved-default',source:'engine:s1'});
  assert.equal(resolveUpgradeOperation({path,projected:{path,value:'Add',source_file:'upgrade.xml'},
    authored:{path,value:'Add',source_file:'upgrade.xml'}}).effective.basis,'explicit-field');
  assert.equal(resolveUpgradeOperation({path,projected:{path,value:'Multiply',source_file:'upgrade.xml'},
    authored:{path,value:'Multiply',source_file:'upgrade.xml'}}).effective.value,'Multiply');
  assert.equal(resolveUpgradeOperation({path}).effective.status,'unresolved');

  const f=fixture(t,{'upgradedata.xml':'<Catalog><CUpgrade id="ExampleUpgrade"/><CUpgrade id="OmittedUpgrade"><EffectArray Reference="Weapon,TestWeapon,Period" Value="0.9"/></CUpgrade></Catalog>'}),search=f.search();
  try {
    const input={operation:'entity.get',catalog:'Upgrade',objectId:'OmittedUpgrade',
      commanderId:'ProtossArtanis',topic:'upgradeEffects'};
    const effect=executeScalarSearch(search,input).upgradeEffects.effects[0];
    assert.equal(effect.operation,null);
    assert.equal(effect.operationSemantics.rawField.exists,false);
    assert.equal(effect.operationSemantics.effective.status,'unresolved');
    const exact=executeScalarSearch(search,{operation:'entity.get',catalog:'Upgrade',objectId:'OmittedUpgrade',
      commanderId:'ProtossArtanis',path:'EffectArray[0].@Operation'});
    assert.deepEqual(exact.operationSemantics,effect.operationSemantics);
    assert.equal(exact.editState.catalogEdit.available,false,'missing raw operation does not fabricate an expect value');
  } finally { search.close(); }
});

test('operand scope relaxes only count consumers for Value edits, never Reference or Operation edits',t=>{
  const f=fixture(t,{'requirementdata.xml':'<Catalog><CRequirementCountUpgrade id="CountWeapon"><Count Link="TestWeaponUpgrade" State="CompleteOnly"/></CRequirementCountUpgrade></Catalog>'});
  const db=new DatabaseSync(f.databaseFile);
  db.prepare('INSERT INTO commander_membership VALUES (?,?,?,?,?)').run('ProtossArtanis','Upgrade','TestWeaponUpgrade','synthetic',0);
  db.prepare('INSERT INTO commander_membership VALUES (?,?,?,?,?)').run('TerranRaynor','Requirement','CountWeapon','synthetic',0);
  db.close();
  const review=(field,expect,value)=>reviewPatchPlan({formatVersion:2,id:'operand-scope',title:'operand-scope',target:'game-a.core',
    compatibility:{sc2DataBuild:'B97579',runtimeContract:2},scope:{kind:'commander',commanderId:'ProtossArtanis'},
    isolation:{strategy:'direct-private',owner:{catalog:'Upgrade',object:'TestWeaponUpgrade'}},
    operations:[{opId:'edit',kind:'catalog.set',catalog:'Upgrade',object:'TestWeaponUpgrade',path:`EffectArray[0].@${field}`,expect,value}]},
    {databaseFile:f.databaseFile,coreRoot:f.coreRoot,phase:'pre'}).diagnostics;
  const value=review('Value',0.9,0.8);
  assert(value.some(d=>d.code==='DIRECT_PRIVATE_BOUNDED_EVIDENCE'),JSON.stringify(value));
  assert(!value.some(d=>d.code==='DIRECT_PRIVATE_HAS_OUTSIDE_COMMANDERS'));
  for(const args of [['Reference','Weapon,TestWeapon,Period','Weapon,TestAirWeapon,Period'],['Operation','Multiply','Add']])
    assert(review(...args).some(d=>d.code==='DIRECT_PRIVATE_HAS_OUTSIDE_COMMANDERS'),args[0]);
});

test('ambiguous XML aliases return their actual conflict without granting a writable current value',t=>{
  const f=fixture(t,{'behaviordata.xml':'<Catalog><CBehaviorBuff id="AmbiguousShield"><DamageResponse ModifyLimit="100"><ModifyLimit value="200"/></DamageResponse></CBehaviorBuff></Catalog>'});
  const search=f.search();
  try{
    const input={operation:'entity.get',catalog:'Behavior',objectId:'AmbiguousShield',path:'DamageResponse.ModifyLimit',commanderId:'ProtossArtanis'};
    const state=executeScalarSearch(search,input).editState;
    assert.equal(state.coreCatalog,null);assert.equal(state.catalogEdit.available,false);assert.equal(state.catalogEdit.expect,undefined);
    assert.equal(state.readDiagnostic.reason,'catalog-projection-executor-disagree');
    assert.deepEqual(state.readDiagnostic.projectedCandidates.map(c=>c.value).sort(),[100,200]);
    assert.equal(state.readDiagnostic.candidatesTruncated,false);
    assert.equal(state.readDiagnostic.executorCandidate.exists,true);
    assert.deepEqual(executeScalarSearch(search,input).editState.readDiagnostic,state.readDiagnostic);
  }finally{search.close();}
});

test('mastery navigation exposes current operands and separate identity-guarded panel metadata',async t=>{
  const f=fixture(t),db=new DatabaseSync(f.databaseFile);
  const profile=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('ProtossArtanis').profile_json);
  profile.masteries=[{id:'ArtanisMastery1',nameZhCN:'Test mastery',links:[{catalog:'Upgrade',objectId:'TestWeaponUpgrade',fieldId:'Upgrade'}]}];
  const insertText=db.prepare('INSERT INTO localized_text VALUES (?,?,?,?)');
  for(let i=0;i<35;i++)insertText.run('zhcn',`Tooltip/Test/${i}`,'<d ref="weapon,testweapon,period"/>','test');
  db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(profile),'ProtossArtanis');db.close();
  const search=f.search(),input={operation:'entity.get',catalog:'Upgrade',objectId:'TestWeaponUpgrade',commanderId:'ProtossArtanis',topic:'mastery'};
  const result=executeScalarSearch(search,input).masteryEvidence;
  const alias=executeScalarSearch(search,{...input,catalog:undefined,objectId:'ArtanisMastery1'});
  assert.equal(alias.responseMode,'mastery-evidence');
  assert.equal(alias.requestedEntryId,'ArtanisMastery1');
  assert.deepEqual(alias.masteryEvidence,result,'an explicit mastery request by instance ID delivers the same complete current evidence');
  assert.equal(result.effects[0].edit.expect,0.9);
  assert.equal(result.effects[0].edit.operation.kind,'catalog.set');
  assert.equal(result.effects[0].target.objectId,'TestWeapon');
  assert.equal(result.effects[0].operation,'Multiply');
  assert.equal(result.panel[0].currentValue,3);
  assert.equal(result.panel[0].edit.available,true,JSON.stringify(result.panel[0]));
  assert.equal(result.panel[0].edit.operation.kind,'catalog.set');
  assert.equal(result.panel[0].edit.operation.path,'Instances[0:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed');
  assert.equal(result.panel[0].definitionScope.boundedPrivate,true);
  assert.equal(result.panel[0].definitionScope.fieldIdentity.ownerCommanderId,'ProtossArtanis');
  assert.equal(result.commanderMetadata.find(r=>r.role==='commander-mastery-ValuePerRank').edit.available,true);
  assert.equal(result.commanderMetadata.find(r=>r.role==='commander-mastery-ValuePerRank').edit.operation.kind,'catalog.set');
  assert.equal(result.commanderMetadata.find(r=>r.role==='commander-mastery-ValuePerRank').definitionScope.boundedPrivate,true);
  assert.equal(result.commanderMetadata.find(r=>r.role==='commander-mastery-MaxRank').definitionScope,null,'rate metadata proof does not cover a rank limit change');
  assert.equal(result.presentation.filter(row=>row.role==='dynamic-tooltip').length,12);
  assert.equal(result.presentationTruncated,true);
  f.catalog({Upgrade:'<CUpgrade id="TestWeaponUpgrade"><EffectArray index="0" Value="0.7"/></CUpgrade>'});
  assert.equal(executeScalarSearch(search,input).masteryEvidence.effects[0].edit.expect,0.7);
  assert.equal(executeScalarSearch(search,{...input,catalog:undefined,objectId:'ArtanisMastery1'}).masteryEvidence.effects[0].edit.expect,0.7);
  assert.throws(()=>executeScalarSearch(search,{...input,catalog:undefined,objectId:'ArtanisMastery1',commanderId:'TerranRaynor'}),/Unknown object or commander entry/);
  assert.throws(()=>executeScalarSearch(search,{...input,path:'MaxLevel'}),/do not combine/);
  assert.throws(()=>executeScalarSearch(search,{...input,commanderId:'TerranRaynor'}),/linked to the selected commander/);
});

test('a mastery alias with multiple Upgrade targets stays explicit instead of selecting one', t=>{
  const f=fixture(t),db=new DatabaseSync(f.databaseFile);
  const profile=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('ProtossArtanis').profile_json);
  profile.masteries=[{id:'CombinedMastery',nameZhCN:'Combined',links:[
    {catalog:'Upgrade',objectId:'TestWeaponUpgrade',fieldId:'Upgrade'},
    {catalog:'Upgrade',objectId:'UnchangedAirUpgrade',fieldId:'Upgrade'},
  ]}];
  db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(profile),'ProtossArtanis');db.close();
  const result=executeScalarSearch(f.search(),{operation:'entity.get',commanderId:'ProtossArtanis',objectId:'CombinedMastery',topic:'mastery'});
  assert.equal(result.responseMode,'commander-entry');
  assert.equal(result.masteryEvidence,undefined);
  assert.equal(result.commanderEntries[0].effectTargets.length,2);
});

test('mastery identity adapter is atomic, repeatable and rejects identity drift while preserving other instances',async t=>{
  const f=fixture(t),search=f.search({reuseSnapshots:true}),p='Instances[0:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed';
  const read=path=>search.execute({operation:'entity.get',catalog:'User',objectId:'MasteryUpgrades',commanderId:'ProtossArtanis',path}).editState;
  const state=read(p);assert.equal(state.edit.available,true,JSON.stringify(state));assert.equal(state.edit.expect,3);
  const details=executeScalarSearch(search,{operation:'entity.get',catalog:'User',objectId:'MasteryUpgrades',commanderId:'ProtossArtanis',path:p});
  assert.equal(details.fieldWarnings,undefined,JSON.stringify(details.fieldWarnings));
  const solved=solveScalar(search,{commanderId:'ProtossArtanis',target:{catalog:'User',objectId:'MasteryUpgrades',path:p},basis:'catalog',meaning:'number',transform:{kind:'set',value:4}});
  assert.ok(JSON.stringify(solved).includes('catalog.set'));
  const op={...state.edit.operation,opId:'point',expect:3,value:4},isolation={strategy:'direct-private',owner:{catalog:'User',object:'MasteryUpgrades'}};
  assert.equal(search.execute({operation:'entity.get',catalog:'User',objectId:'MasteryUpgrades',commanderId:'TerranRaynor',path:p}).editState.edit.reason,'mastery-scope-mismatch');
  await assert.rejects(f.apply('user-foreign',[op],[],{isolation,scope:{kind:'commander',commanderId:'TerranRaynor'}}),error=>error.review?.diagnostics.some(d=>d.code==='DIRECT_PRIVATE_HAS_OUTSIDE_COMMANDERS'));
  await f.apply('user-first',[op],[],{isolation});
  assert.equal(read(p).edit.expect,4);assert.deepEqual(read(p).edit.requiredDependsOn,['user-first']);
  assert.equal(read('Instances[1:OtherMastery].Fixed[0:PointIncrement].@Fixed').coreCatalog.value,7);
  const firstHash=await treeHash(f.coreRoot);
  await f.apply('user-first',[op],[],{isolation});assert.equal(await treeHash(f.coreRoot),firstHash);
  assert.equal(read('Instances[1:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed').edit.available,false);
  await assert.rejects(f.apply('user-wrong',[{...op,path:'Instances[1:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed',expect:7,value:8}],[],{isolation}),/position and Id/);
  assert.equal(await treeHash(f.coreRoot),firstHash);
  await f.apply('user-second',[{...op,expect:4,value:5}],['user-first'],{isolation});
  assert.equal(read(p).edit.expect,5);
  const emitted=readFileSync(path.join(f.coreRoot,'Base.SC2Data/GameData/UserData.xml'),'utf8');
  assert.match(emitted,/<Instances index="0" Id="ArtanisMastery1">\s*<Fixed index="0" Fixed="5">\s*<Field Id="PointIncrement"\/>/);
  assert.doesNotMatch(emitted,/OtherMastery/);
  search.close();
});

test('mastery artifact audit checks identity scaffolding and rejects undeclared sibling edits',async t=>{
  const f=fixture(t),staged=path.join(f.repoRoot,'staged');cpSync(f.coreRoot,staged,{recursive:true});
  const plan={id:'audit-user',operations:[{opId:'point',kind:'catalog.set',catalog:'User',object:'MasteryUpgrades',path:'Instances[0:ArtanisMastery1].Fixed[0:PointIncrement].@Fixed',expect:3,value:4}]};
  const application=await applyPlanToCore({coreRoot:staged,catalogRoot:path.join(path.dirname(f.databaseFile),'merged/GameData'),plan});
  const audit=()=>auditPatchArtifacts({beforeCore:f.coreRoot,afterCore:staged,plan,application});await audit();
  const file=path.join(staged,'Base.SC2Data/GameData/UserData.xml'),source=readFileSync(file,'utf8');
  for(const changed of [source.replace('Id="ArtanisMastery1"','Id="OtherMastery"'),source.replace('Id="PointIncrement"','Id="OtherField"'),source.replace('</CUser>','<Instances index="1" Id="OtherMastery"><Fixed Fixed="9"/></Instances></CUser>')]) {
    writeFileSync(file,changed);await assert.rejects(audit(),/Undeclared artifact field change/);
  }
});

test('proven Commander ValuePerRank edits preserve sibling metadata, enforce expect and support continuous commits',async t=>{
  const f=fixture(t),search=f.search({reuseSnapshots:true});
  const read=(path='MasteryTalentArray[0].ValuePerRank')=>search.execute({operation:'entity.get',catalog:'Commander',objectId:'Artanis',commanderId:'ProtossArtanis',path}).editState;
  const state=read();
  const details=executeScalarSearch(search,{operation:'entity.get',catalog:'Commander',objectId:'Artanis',commanderId:'ProtossArtanis',path:'MasteryTalentArray[0].ValuePerRank'});
  assert.equal(details.fieldWarnings,undefined,JSON.stringify(details.fieldWarnings));
  assert.equal(state.edit.available,true,JSON.stringify(state));
  assert.equal(state.edit.operation.kind,'catalog.set');assert.equal(state.edit.expect,3);
  const isolation={strategy:'direct-private',owner:{catalog:'Commander',object:'Artanis'}};
  await assert.rejects(f.apply('panel-foreign',[{...state.edit.operation,opId:'panel',expect:3,value:4}],[],{isolation,scope:{kind:'commander',commanderId:'TerranRaynor'}}),error=>error.review?.diagnostics.some(d=>d.code==='DIRECT_PRIVATE_HAS_OUTSIDE_COMMANDERS'));
  await f.apply('panel-first',[{...state.edit.operation,opId:'panel',expect:3,value:4}],[],{isolation});
  assert.equal(read().edit.expect,4);
  assert.deepEqual(read().edit.requiredDependsOn,['panel-first']);
  for(const [field,value] of [['MasteryTalentArray[0].MaxRank',30],['MasteryTalentArray[0].Talent','TestWeaponUpgrade'],['MasteryTalentArray[1].ValuePerRank',7]])assert.equal(read(field).coreCatalog.value,value);
  const before=await treeHash(f.coreRoot);
  await assert.rejects(f.apply('panel-stale',[{...state.edit.operation,opId:'panel',expect:3,value:5}],['panel-first'],{isolation}),/expect|Expected|precondition/i);
  assert.equal(await treeHash(f.coreRoot),before);
  await f.apply('panel-second',[{...state.edit.operation,opId:'panel',expect:4,value:5}],['panel-first'],{isolation});
  assert.equal(read().edit.expect,5);assert.deepEqual(read().edit.requiredDependsOn,['panel-first','panel-second']);
  const xml=readFileSync(path.join(f.coreRoot,'Base.SC2Data/GameData/CommanderData.xml'),'utf8');
  assert.match(xml,/<MasteryTalentArray index="0">\s*<ValuePerRank value="5"\/>/);
  assert.doesNotMatch(xml,/Talent=|MaxRank=|index="1"/);
  search.close();
});

test('query, solver and atomic executor agree on unsafe identity-keyed ordinal fields', async t => {
  const f=fixture(t),catalogRoot=path.join(path.dirname(f.databaseFile),'merged/GameData');
  const input={operation:'entity.get',catalog:'User',objectId:'MasteryUpgrades',path:'Instances[0].Fixed.@Fixed'};
  const state=f.search().execute(input).editState;
  assert.equal(state.coreCatalog.value,3,'ordinal remains readable evidence');
  assert.equal(state.catalogEdit.available,false);
  assert.equal(state.catalogEdit.reason,'identity-selector-required');
  assert.match(state.catalogEdit.diagnostic.message,/identity-preserving editor/);
  assert.throws(()=>solveScalar(f.search(),{commanderId:'ProtossArtanis',target:{catalog:input.catalog,objectId:input.objectId,path:input.path},basis:'catalog',meaning:'number',transform:{kind:'set',value:4}}),/identity-selector-required/);
  const before=await treeHash(f.coreRoot);
  for (const expect of [3,null,4]) {
    const plan={formatVersion:2,id:'unsafe-ordinal',title:'Unsafe ordinal',userSummary:{text:'Test'},target:'game-a.core',compatibility:{sc2DataBuild:'B97579',runtimeContract:2},
      scope:{kind:'commander',commanderId:'ProtossArtanis'},isolation:{strategy:'direct-private',owner:{catalog:'User',object:'MasteryUpgrades'}},
      operations:[{opId:'valid-first',kind:'catalog.set',catalog:'Unit',object:'Dragoon',path:'LifeMax',expect:100,value:120},
        {opId:'unsafe',kind:'catalog.set',catalog:input.catalog,object:input.objectId,path:input.path,expect,value:4}]};
    write(f.repoRoot,'unsafe.json',plan);
    await assert.rejects(executePatchPlan({repoRoot:f.repoRoot,planPath:'unsafe.json',catalogRoot,runGameAValidation:false}),/identity-preserving editor/);
    assert.equal(await treeHash(f.coreRoot),before,'a later unsafe edit must roll back the valid first edit');
  }
  f.catalog({User:'<CUser id="MasteryUpgrades"><Instances index="0"><Fixed Fixed="4"/></Instances></CUser>'});
  assert.equal(f.search().execute(input).editState.catalogEdit.available,false,'an old sparse override cannot launder the baseline identity');
  await assert.rejects(applyPlanToCore({coreRoot:f.coreRoot,catalogRoot,plan:{id:'unsafe-retry',operations:[{opId:'unsafe',kind:'catalog.set',catalog:input.catalog,object:input.objectId,path:input.path,expect:4,value:5}]}}),/identity-preserving editor/);
});

test('default reverse influences read current overlay, scoped plans and continuous edits without changing the database', async t => {
  const f=fixture(t),beforeDatabase=hash(f.databaseFile);
  const ask=(catalog,objectId,path,extra={})=>executeScalarSearch(f.search(),{operation:'entity.get',commanderId:'ProtossArtanis',catalog,objectId,path,...extra});
  assert.equal(ask('Weapon','TestWeapon','Period').fieldInfluences.entries[0].operand,'0.9');
  f.catalog({Upgrade:'<CUpgrade id="TestWeaponUpgrade"><EffectArray index="0" Reference="Weapon,TestWeapon,Period" Operation="Multiply" Value="0.8"/></CUpgrade>'});
  assert.equal(ask('Weapon','TestWeapon','Period').fieldInfluences.entries[0].operand,'0.8');
  f.catalog({Upgrade:'<CUpgrade id="TestWeaponUpgrade"><EffectArray index="0" Reference="Weapon,TestAirWeapon,Period" Operation="Multiply" Value="0.7"/></CUpgrade>'});
  assert.equal(ask('Weapon','TestWeapon','Period').fieldInfluences.total,0,'old target must not reappear from baseline index');
  assert.ok(ask('Weapon','TestAirWeapon','Period').fieldInfluences.entries.some(e=>e.objectId==='TestWeaponUpgrade'&&e.operand==='0.7'));
  const op={opId:'life',kind:'commander.stat.set',commanderId:'ProtossArtanis',prestigeUpgrade:'ExampleUpgrade',catalog:'Unit',object:'Dragoon',path:'LifeMax',expect:100,value:125};
  await f.apply('first-conditional-life',[op]);
  const id=commanderStatIdentity(op).upgradeId;
  for(const extra of [{},{prestigeUpgrade:'ExampleUpgrade'}]) {
    const e=ask('Unit','Dragoon','LifeMax',extra).fieldInfluences.entries.find(e=>e.objectId===id);
    assert(e,'conditional candidates must remain visible without a selected prestige');
    assert.equal(e.operand,'125');assert.equal(e.conditions.find(c=>c.kind==='project-scope').prestigeUpgrade,'ExampleUpgrade');
    assert.equal(e.activationVerified,false);
  }
  await f.apply('second-conditional-life',[{...op,expect:125,value:150}],['first-conditional-life']);
  const e=ask('Unit','Dragoon','LifeMax',{prestigeUpgrade:'ExampleUpgrade'}).fieldInfluences.entries.find(e=>e.objectId===id);
  assert.equal(e.operand,'150');assert.equal(e.conditions.find(c=>c.kind==='project-scope').planId,'second-conditional-life');
  assert.equal(hash(f.databaseFile),beforeDatabase);
});

test('scalar solver reads project overrides, applies an inverse prestige edit, and continues from the result', async t => {
  const f = fixture(t);
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="50"/></CUnit>',
    Upgrade: '<CUpgrade id="ExampleUpgrade"><EffectArray index="0" Operation="Subtract" Reference="Unit,Dragoon,LifeMax" Value="40"/></CUpgrade>' });
  const beforeDatabase = hash(f.databaseFile);
  const input = { commanderId: 'ProtossArtanis', prestigeUpgrade: 'ExampleUpgrade',
    target: { catalog: 'Unit', objectId: 'Dragoon', path: 'LifeMax' }, transform: { kind: 'multiply', value: 0.6 } };
  const first = solveScalar(f.search(), input);
  assert.equal(first.catalogValue, 50); assert.equal(first.currentValue, 10);
  assert.equal(first.desiredValue, 6); assert.equal(first.operation.value, 44);
  const plan = { formatVersion: 2, id: 'inverse-prestige', title: 'Inverse prestige', target: 'game-a.core',
    compatibility: { sc2DataBuild: 'B97579', runtimeContract: 2 },
    scope: { kind: 'commander', commanderId: 'ProtossArtanis' },
    isolation: { strategy: 'direct-private', owner: { catalog: 'Upgrade', object: 'ExampleUpgrade' } },
    operations: [first.operation] };
  checkScalarCalculations(f.search(), plan, [{ input, result: first }]);
  write(f.repoRoot, 'inverse.patch-plan.json', plan);
  await executePatchPlan({ repoRoot: f.repoRoot, planPath: 'inverse.patch-plan.json',
    catalogRoot: path.join(path.dirname(f.databaseFile), 'merged/GameData'), runGameAValidation: false });
  const second = solveScalar(f.search(), { ...input, transform: { kind: 'multiply', value: 0.5 } });
  assert.equal(second.currentValue, 6); assert.equal(second.desiredValue, 3);
  assert.equal(second.operation.expect, 44); assert.equal(second.operation.value, 47);
  assert.deepEqual(second.requiredDependsOn, ['inverse-prestige']);
  assert.equal(hash(f.databaseFile), beforeDatabase, 'solver must not mutate the official database');
  const output = readFileSync(path.join(f.coreRoot, 'Base.SC2Data/GameData/UpgradeData.xml'), 'utf8');
  assert.match(output, /Operation="Subtract"/); assert.match(output, /Reference="Unit,Dragoon,LifeMax"/);
});

test('Upgrade numeric attributes round-trip through query, executor and artifact verification', async t => {
  const f = fixture(t);
  const query = path => f.search().execute({ operation: 'entity.get', catalog: 'Upgrade', objectId: 'TestWeaponUpgrade', path, include: ['fields', 'effectiveField'] });
  const before = query('EffectArray[0]');
  assert.equal(before.editState.catalogEdit.available, true, JSON.stringify(before.editState));
  assert.equal(before.editState.catalogEdit.expect, 0.9);
  assert.equal(before.editState.catalogEdit.operation.path, 'EffectArray[0].@Value');
  const scoped = f.search().execute({operation:'entity.get',commanderId:'ProtossArtanis',catalog:'Upgrade',objectId:'TestWeaponUpgrade',path:'EffectArray[0].@Value'});
  assert.equal(scoped.editState.edit.operation.kind,'catalog.set');
  assert.equal(scoped.editState.edit.operation.commanderId,undefined);
  assert.equal(scoped.editState.edit.expect,0.9);
  assert.equal(query('EffectArray[0].@Value').effectiveField.field.value, 0.9);
  const op = { opId: 'change', ...before.editState.catalogEdit.operation, expect: 0.9, value: 0.8 };
  const plan = { formatVersion: 2, id: 'attribute-roundtrip', title: 'Attribute roundtrip', target: 'game-a.core',
    compatibility: { sc2DataBuild: 'B97579', runtimeContract: 2 },
    scope: { kind: 'global' }, isolation: { strategy: 'global' }, operations: [op] };
  const catalogRoot = path.join(path.dirname(f.databaseFile), 'merged/GameData');
  for (const expect of [true, 0.9, undefined]) {
    await assert.rejects(applyPlanToCore({ coreRoot: f.coreRoot, catalogRoot,
      plan: { ...plan, operations: [{ ...op, path: 'EffectArray[0]', expect }] } }), /Non-canonical/);
  }
  write(f.repoRoot, 'attribute.patch-plan.json', plan);
  await executePatchPlan({ repoRoot: f.repoRoot, planPath: 'attribute.patch-plan.json', catalogRoot, runGameAValidation: false });
  assert.equal(query('EffectArray[0].@Value').editState.catalogEdit.expect, 0.8);
  const output = readFileSync(path.join(f.coreRoot, 'Base.SC2Data/GameData/UpgradeData.xml'), 'utf8');
  assert.match(output, /Value="0.8"/);
  assert.doesNotMatch(output, /value="0.8"/);
  const after = query('EffectArray[0].@Reference');
  assert(after.fields.some(x => x.value === 'Weapon,TestWeapon,Period'));
});

test('prestige scalar activation is generated and current values do not leak into other prestiges', async t => {
  const f = fixture(t);
  const op = { opId: 'life', kind: 'commander.stat.set', commanderId: 'ProtossArtanis',
    prestigeUpgrade: 'ExampleUpgrade', catalog: 'Unit', object: 'Dragoon', path: 'LifeMax', expect: 100, value: 200 };
  await f.apply('conditional-life', [op]);
  const identity = commanderStatIdentity(op);
  const source = readFileSync(path.join(f.coreRoot, `Base.SC2Data/Generated/CommanderUpgrade_${identity.scopeHash}.galaxy`), 'utf8');
  assert.match(source, /UserDataGetGameLink\("PlayerPrestige", prestige, "PrimaryUpgrade", 1\) == "ExampleUpgrade"/);
  assert.doesNotMatch(source, /TechTreeUpgradeCount\(player, "ExampleUpgrade"/);
  const input = { operation: 'entity.get', commanderId: 'ProtossArtanis', catalog: 'Unit', objectId: 'Dragoon', path: 'LifeMax' };
  assert.equal(f.search().execute(input).editState.edit.expect, 100);
  assert.equal(f.search().execute({ ...input, prestigeUpgrade: 'ExampleUpgrade' }).editState.edit.expect, 200);
  assert.notEqual(identity.upgradeId, commanderStatIdentity({ ...op, prestigeUpgrade: undefined }).upgradeId);
  const query = { ...input, prestigeUpgrade: 'ExampleUpgrade' };
  const current = f.search().execute(query);
  assert.equal(current.currentProject.prestigeUpgrade, 'ExampleUpgrade');
  assert.equal(current.editState.edit.operation.prestigeUpgrade, 'ExampleUpgrade');
  await f.apply('conditional-life-again', [{ ...current.editState.edit.operation, opId: 'life', expect: 200, value: 250 }], ['conditional-life']);
  assert.equal(f.search().execute(query).editState.edit.expect, 250);
  assert.equal(f.search().execute(input).editState.edit.expect, 100);
  assert.throws(() => f.search().execute({ ...query, prestigeUpgrade: 'UnknownPrestige' }), /prestigeUpgrade requires/);
  const search = f.search();
  search.withProjectDatabase(query, () => {
    assert.throws(() => search.execute({ ...query, prestigeUpgrade: null }), /Cannot change prestige scope/);
  });
  rmSync(path.join(f.repoRoot, 'game-a/patches/conditional-life.patch-plan.json'));
  rmSync(path.join(f.repoRoot, 'game-a/patches/conditional-life-again.patch-plan.json'));
  assert.equal(f.search().execute(query).editState.edit.expect, 250, 'current conditional value survives unavailable historical plans');
  assert.equal(f.search().execute(input).editState.edit.expect, 100);
});

for (const newline of ['\n', '\r\n']) test(`legacy prestige activation migrates with a new receipt (${JSON.stringify(newline)})`, async t => {
  const f = fixture(t);
  const op = { opId: 'life', kind: 'commander.stat.set', commanderId: 'ProtossArtanis',
    prestigeUpgrade: 'ExampleUpgrade', catalog: 'Unit', object: 'Dragoon', path: 'LifeMax', expect: 100, value: 200 };
  await f.apply('legacy-life', [op]);
  const id = commanderStatIdentity(op);
  const relative = `Base.SC2Data/Generated/CommanderUpgrade_${id.scopeHash}.galaxy`;
  const file = path.join(f.coreRoot, relative);
  const currentSource = readFileSync(file, 'utf8');
  const legacySource = currentSource.replace('    string prestige;\n', '')
    .replace('        prestige = libCOOC_gf_CC_PlayerActivePrestigeInstance(player);\n', '')
    .replace('prestige != null && UserDataGetGameLink("PlayerPrestige", prestige, "PrimaryUpgrade", 1) == "ExampleUpgrade"',
      'TechTreeUpgradeCount(player, "ExampleUpgrade", c_techCountCompleteOnly) > 0')
    .replaceAll('\n', newline);
  write(f.coreRoot, relative, legacySource);
  // Seed the old executor's recorded final state, not an unrecorded file drift.
  const receiptPath = 'game-a/patches/legacy-life.receipt.json';
  const receipt = JSON.parse(readFileSync(path.join(f.repoRoot, receiptPath), 'utf8'));
  receipt.coreTreeAfterSha256 = await treeHash(f.coreRoot);
  write(f.repoRoot, receiptPath, receipt);
  const oldReceiptHash = hash(path.join(f.repoRoot, receiptPath));
  const oldTree = await treeHash(f.coreRoot);
  await assert.rejects(f.apply('legacy-life', [op]), /Legacy prestige activation requires a new dependent PatchPlan/);
  assert.equal(await treeHash(f.coreRoot), oldTree);
  const upgradeFile = path.join(f.coreRoot, 'Base.SC2Data/GameData/UpgradeData.xml');
  const upgradeHash = hash(upgradeFile);
  const repair = { ...op, expect: 200, value: 200 };
  const result = await f.apply('repair-activation', [repair], ['legacy-life']);
  assert.deepEqual(result.changedFiles, [relative]);
  assert.equal(result.receiptRecorded, true);
  assert.equal(readFileSync(file, 'utf8'), currentSource);
  assert.equal(hash(upgradeFile), upgradeHash, 'repair must not change numeric effects or Upgrade identity');
  assert.equal(hash(path.join(f.repoRoot, receiptPath)), oldReceiptHash, 'historical receipt stays immutable');
  assert.equal(result.receipt.coreTreeBeforeSha256, oldTree);
  assert.equal(result.receipt.coreTreeAfterSha256, await treeHash(f.coreRoot));
  const repeat = await f.apply('repair-activation', [repair], ['legacy-life']);
  assert.deepEqual(repeat.changedFiles, []);
  assert.equal(repeat.receiptRecorded, false);
  assert.equal(f.search().execute({ operation: 'entity.get', commanderId: 'ProtossArtanis',
    prestigeUpgrade: 'ExampleUpgrade', catalog: 'Unit', objectId: 'Dragoon', path: 'LifeMax' }).editState.edit.expect, 200);
});

test('prestige runtime migration rejects customized source and rolls back numeric changes', async t => {
  const f = fixture(t);
  const op = { opId: 'life', kind: 'commander.stat.set', commanderId: 'ProtossArtanis',
    prestigeUpgrade: 'ExampleUpgrade', catalog: 'Unit', object: 'Dragoon', path: 'LifeMax', expect: 100, value: 200 };
  await f.apply('custom-life', [op]);
  const id = commanderStatIdentity(op);
  const relative = `Base.SC2Data/Generated/CommanderUpgrade_${id.scopeHash}.galaxy`;
  write(f.coreRoot, relative, readFileSync(path.join(f.coreRoot, relative), 'utf8') + '// user customization\n');
  const before = await treeHash(f.coreRoot);
  await assert.rejects(f.apply('custom-life-next', [{ ...op, expect: 200, value: 250 }], ['custom-life']),
    /expectSha256 is required/);
  assert.equal(await treeHash(f.coreRoot), before, 'failed migration must roll back staged numeric changes');
  assert.throws(() => readFileSync(path.join(f.repoRoot, 'game-a/patches/custom-life-next.receipt.json')), /ENOENT/);
});

test('field pagination provides every row once with numeric array ordering', t => {
  const f = fixture(t);
  const input = { operation: 'entity.get', catalog: 'Unit', objectId: 'Dragoon', limit: 2 };
  const collected = [];
  let offset = 0, page;
  do { page = f.search().execute({ ...input, offset }); collected.push(...page.fields.map(x => x.path)); offset = page.nextOffset; } while (offset !== null);
  assert.equal(collected.length, page.totalFields);
  assert.equal(new Set(collected).size, collected.length);
  assert.deepEqual(collected, [...collected].sort((a,b) => a.localeCompare(b, 'en', { numeric: true })));
});

const privateRequest = () => ({ id: 'helper-private-ship', title: 'Private ship', summary: 'Change only the selected commander ship.',
  commanderId: 'ProtossArtanis', sourceUnit: 'Tempest', sourceActor: 'Tempest',
  redirects: [{ catalog: 'Abil', objectId: 'TestTrain', path: 'InfoArray[Train8].Unit[0]' }],
  changes: [{ catalog: 'Weapon', objectId: 'TestWeapon', path: 'Period', value: 0.75 },
    { catalog: 'Unit', objectId: 'Tempest', path: 'Speed', value: 3 }] });

test('privateUnit writer expands real evidence to an executable scoped draft and never applies it', async t => {
  const f = fixture(t);
  const core = createCoopAgentCore({ ...f, runGameAValidation: false });
  const before = readFileSync(path.join(f.coreRoot, 'GameA.Core.json'), 'utf8');
  const result = await core.writePatchPlan({ privateUnit: privateRequest() });
  assert.equal(result.status, 'written'); assert.equal(result.draftOnly, true);
  assert.equal(result.review.status, 'draft-only'); assert.deepEqual(result.unresolved, []);
  assert(result.review.obligations.some(item => item.kind === 'upgrade-reference' && item.source.objectId === 'TestWeaponUpgrade'));
  assert(!result.review.obligations.some(item => item.source.objectId === 'UnchangedAirUpgrade'), 'unchanged air weapon does not trigger its upgrade investigation');
  assert(result.review.specialChecks.some(item => item.kind === 'actor-event-expressions'));
  assert.equal(readFileSync(path.join(f.coreRoot, 'GameA.Core.json'), 'utf8'), before);
  const plan = JSON.parse(readFileSync(path.join(f.repoRoot, result.planPath), 'utf8'));
  assert.deepEqual(plan, result.plan);
  assert.equal(plan.operations.filter(op => op.kind === 'catalog.clone').length, 1, 'unchanged air weapon and damage effect stay shared');
  const clone = plan.operations[0];
  const weapon = result.mapping.find(m => m.catalog === 'Weapon').object;
  assert(plan.operations.some(op => op.object === clone.unitId && op.path === 'WeaponArray[0].Link' && op.value === weapon));
  assert(plan.operations.some(op => op.object === weapon && op.path === 'Period' && op.expect === 1.5 && op.value === 0.75));
  const repeated = await core.writePatchPlan({ privateUnit: privateRequest() });
  assert.deepEqual(repeated.plan, plan);
  const execution = { repoRoot: f.repoRoot, planPath: result.planPath, databaseFile: f.databaseFile,
    catalogRoot: path.join(path.dirname(f.databaseFile), 'merged/GameData'), runGameAValidation: false };
  await executePatchPlan(execution);
  assert.deepEqual((await executePatchPlan(execution)).changedFiles, []);
  for (const commanderId of ['ProtossArtanis', 'TerranRaynor', null]) {
    const artifacts = openGameAArtifacts({ ...f, commanderId });
    try {
      assert.equal(artifacts.field('Abil', 'TestTrain', 'InfoArray[Train8].Unit[0]'), commanderId === 'ProtossArtanis' ? clone.unitId : 'Tempest');
      assert.equal(Number(artifacts.field('Weapon', 'TestWeapon', 'Period')), 1.5);
      assert.equal(Number(artifacts.field('Weapon', weapon, 'Period')), 0.75);
    } finally { artifacts.close(); }
  }
});

test('private drafting saves proven foundation, reports field gaps and protects an existing design', async t => {
  const f = fixture(t); const core = createCoopAgentCore({ ...f, runGameAValidation: false });
  const request = privateRequest(); request.changes = [{ catalog: 'Weapon', objectId: 'TestWeapon', path: 'UnknownField', value: 4 }];
  const result = await core.writePatchPlan({ privateUnit: request });
  assert.equal(result.unresolved.length, 1); assert.equal(result.plan.operations.length, 1);
  assert.equal(result.mapping.length, 2, 'unresolved dependency is not cloned');
  const revised = { ...result.plan, title: 'Human or model revision' };
  await core.writePatchPlan({ plan: revised });
  const extended = await core.writePatchPlan({ privateUnit: privateRequest() });
  assert.equal(extended.plan.title, revised.title);
  assert.equal(extended.plan.operations.length, 5, 'append weapon clone, its rewire, period and speed to the same foundation');
  assert.deepEqual((await core.writePatchPlan({ privateUnit: privateRequest() })).plan, extended.plan);
  const changedRequest = privateRequest(); changedRequest.changes[0].value = 0.5;
  await assert.rejects(core.writePatchPlan({ privateUnit: changedRequest }), /designed differently/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.repoRoot, result.planPath), 'utf8')), extended.plan);
  await assert.rejects(core.writePatchPlan({ plan: revised, privateUnit: request }), /either/);
  await assert.rejects(core.writePatchPlan({ privateUnit: { ...request, id: 'bad-source', sourceActor: 'Missing' } }), /Unknown Catalog/);
  await assert.rejects(core.writePatchPlan({ privateUnit: { ...request, id: 'bad-entry', redirects: [{ catalog: 'Unit', objectId: 'Tempest', path: 'LifeMax' }] } }), /proven creation/);
});

test('private draft extension preserves manual operations and refuses colliding targets under different op IDs', async t => {
  const f = fixture(t); const core = createCoopAgentCore({ ...f, runGameAValidation: false });
  const foundation = await core.writePatchPlan({ privateUnit: { ...privateRequest(), changes: [] } });
  const clone = foundation.plan.operations[0];
  const manual = { opId: 'designer-speed', kind: 'catalog.set', catalog: 'Unit', object: clone.unitId, path: 'Speed', expect: 2, value: 5 };
  await core.writePatchPlan({ plan: { ...foundation.plan, operations: [...foundation.plan.operations, manual] } });
  const oldBytes = readFileSync(path.join(f.repoRoot, foundation.planPath), 'utf8');
  await assert.rejects(core.writePatchPlan({ privateUnit: privateRequest() }), /overlaps existing/);
  assert.equal(readFileSync(path.join(f.repoRoot, foundation.planPath), 'utf8'), oldBytes);
  const request = privateRequest(); request.changes = request.changes.filter(c => c.catalog === 'Weapon');
  const result = await core.writePatchPlan({ privateUnit: request });
  assert.deepEqual(result.plan.operations[1], manual);
  await executePatchPlan({ repoRoot: f.repoRoot, planPath: result.planPath, databaseFile: f.databaseFile,
    catalogRoot: path.join(path.dirname(f.databaseFile), 'merged/GameData'), runGameAValidation: false });
  assert.equal(f.get(clone.unitId, 'Speed').editState.catalogEdit.expect, 5);
});

test('ambiguous shared effects require an explicit owner path, not a hidden graph choice', async t => {
  const f = fixture(t); const core = createCoopAgentCore({ ...f, runGameAValidation: false });
  const request = privateRequest(); request.changes = [{ catalog: 'Effect', objectId: 'OldEffect', path: 'Amount', value: 20 }];
  const ambiguous = await core.writePatchPlan({ privateUnit: request });
  assert.equal(ambiguous.unresolved.length, 1);
  assert.match(ambiguous.unresolved[0].message, /ownerPath/);
  assert(ambiguous.unresolved[0].candidates.length >= 2);
  const chosen = ambiguous.unresolved[0].candidates.find(steps => steps.some(s => s.objectId === 'TestWeapon'));
  const selected = await core.writePatchPlan({ privateUnit: { ...request, id: 'chosen-effect-path', changes: [{ ...request.changes[0], ownerPath: chosen }] } });
  assert.deepEqual(selected.unresolved, []);
  assert.equal(selected.plan.operations.filter(op => op.kind === 'catalog.clone').length, 2);
  assert(!selected.mapping.some(m => m.source === 'TestAirWeapon'));
});

test("real commander clone redirects satisfy the staged contract and remain commander scoped", async (t) => {
  const f = fixture(t);
  const plan = { formatVersion: 2, id: "scoped-clone", title: "Clone", userSummary: { text: "Create the test clone." },
    target: "game-a.core", compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
    scope: { kind: "commander", commanderId: "ProtossArtanis" },
    isolation: { strategy: "private-clone", owner: { catalog: "Unit", object: "Tempest" } },
    operations: [{ opId: "clone", kind: "commander.unit.clone", commanderId: "ProtossArtanis",
      sourceUnit: "Tempest", unitId: "TestPrivateTempest", sourceActor: "Tempest", actorId: "TestPrivateTempest",
      redirects: [{ catalog: "Abil", object: "TestTrain", path: "InfoArray[Train8].Unit[0]", expect: "Tempest" }] },
    { opId: "private-speed", kind: "catalog.set", catalog: "Unit", object: "TestPrivateTempest", path: "Speed", expect: 2, value: 3 },
    { opId: "customize-actor", kind: "catalog.set", catalog: "Actor", object: "TestPrivateTempest", path: "BarWidth", value: 88 }],
    postconditions: [{ postId: "reachable", kind: "unit.clone", commanderId: "ProtossArtanis", sourceUnitId: "Tempest",
      unitId: "TestPrivateTempest", sourceActorId: "Tempest", actorId: "TestPrivateTempest", nameKey: "Unit/Name/Tempest",
      entrypoints: [{ kind: "catalog", catalog: "Abil", object: "TestTrain", path: "InfoArray[Train8].Unit[0]" }] }] };
  write(f.repoRoot, "clone.json", plan);
  const options = { repoRoot: f.repoRoot, planPath: "clone.json", databaseFile: f.databaseFile,
    catalogRoot: path.join(path.dirname(f.databaseFile), "merged/GameData"), runGameAValidation: false };
  await executePatchPlan(options).catch(error => {
    assert.fail(JSON.stringify({ message: error.message, review: error.review, details: error.details }));
  });
  for (const commanderId of ["ProtossArtanis", "TerranRaynor", null]) {
    const artifacts = openGameAArtifacts({ ...f, commanderId });
    try {
      assert.equal(artifacts.field("Abil", "TestTrain", "InfoArray[Train8].Unit[0]"),
        commanderId === "ProtossArtanis" ? "TestPrivateTempest" : "Tempest");
      assert.equal(artifacts.field("Abil", "TestTrain", "InfoArray[Train8].Unit", false), "Tempest");
    } finally { artifacts.close(); }
  }
  assert.equal(f.get('Tempest', 'Speed').editState.catalogEdit.expect, 2, 'original stays unchanged');
  assert.equal(f.get('TestPrivateTempest', 'Speed').editState.catalogEdit.expect, 3);
  const existing = f.search().execute({ operation: 'impact.analyze', catalog: 'Unit', objectId: 'TestPrivateTempest',
    scope: { kind: 'commander', commanderId: 'ProtossArtanis' }, includeIsolationPlan: true });
  assert.equal(existing.isolation.recommendedStrategy, 'inspect-existing-private');
  assert.deepEqual(existing.isolation.cloneCandidates, [], 'do not recursively clone a local variant by default');
  const repeated = await executePatchPlan(options); // Same-plan Actor customization must survive retry.
  assert.deepEqual(repeated.changedFiles, []);
  assert.ok(repeated.operations.every(op => op.status === "already"));
  const actorPath = path.join(f.coreRoot, "Base.SC2Data/GameData/ActorData.xml");
  writeFileSync(actorPath, readFileSync(actorPath, "utf8").replace('value="88"', 'value="99"'));
  await assert.rejects(executePatchPlan(options), /has been customized/, "Do not bless foreign Actor changes as an idempotent retry");
});

test('query and impact share clone-first routing, including same-field Upgrade continuation', async (t) => {
  const f = fixture(t);
  const life = f.get().editState;
  assert.equal(life.authoringRoute.reason, 'upgrade-whitelist');
  assert.equal(life.edit.recommended, true);
  const speed = f.get('Tempest', 'Speed').editState;
  assert.equal(speed.edit.available, true, 'preserve low-level descriptor compatibility');
  assert.equal(speed.edit.recommended, false, 'readable descriptor is not a preferred authoring route');
  assert.equal(speed.authoringRoute.strategy, 'private-clone');
  const impact = f.search().execute(speed.authoringRoute.nextQuery);
  assert.equal(impact.isolation.recommendedStrategy, 'private-clone');
  assert.deepEqual(impact.isolation.owner, { catalog: 'Unit', objectId: 'Tempest' });
  assert(impact.isolation.ownerEntrypoints.creationRewires.some(r => r.path === 'InfoArray[Train8].Unit[0]'));
  const explicitScalar = f.search().execute({ ...speed.authoringRoute.nextQuery, path: 'Speed', changeType: 'scalar' });
  assert.equal(explicitScalar.isolation.recommendedStrategy, 'private-clone', 'numeric shape alone is not a whitelist');
  assert.equal(explicitScalar.isolation.cloneCandidates.length, 1);
  await f.apply('legacy-speed', [{ opId: 'speed', kind: 'commander.stat.set', commanderId: 'ProtossArtanis',
    catalog: 'Unit', object: 'Tempest', path: 'Speed', expect: 2, value: 3 }]);
  const current = f.get('Tempest', 'Speed').editState;
  assert.equal(current.authoringRoute.reason, 'existing-scoped-edit');
  assert.equal(current.edit.expect, 3);
  assert.equal(current.catalogEdit.expect, 2, 'clone input cannot substitute the player Upgrade value');
  const continued = f.search().execute({ ...speed.authoringRoute.nextQuery, path: 'Speed', changeType: 'scalar' });
  assert.equal(continued.isolation.authoringRoute.reason, 'existing-scoped-edit', 'scope selects the player overlay without redundant commanderId');
  assert.equal(continued.isolation.recommendedStrategy, 'player-upgrade');
  assert.deepEqual(continued.isolation.rewireCandidates, []);
  const other = f.search().execute({ ...speed.authoringRoute.nextQuery, scope: { kind: 'commander', commanderId: 'TerranRaynor' },
    path: 'Speed', changeType: 'scalar' });
  assert.equal(other.isolation.recommendedStrategy, 'private-clone', 'another commander does not inherit the compatibility shortcut');
  const mechanism = f.search().execute(speed.authoringRoute.nextQuery);
  assert.equal(mechanism.isolation.recommendedStrategy, 'private-clone', 'legacy scalar cannot replace a behavior request');
  assert.throws(() => f.search().execute({ ...speed.authoringRoute.nextQuery, commanderId: 'TerranRaynor' }), /must match/);
});

test("engine baseline feeds UI/MCP/executor and unknown edited-parent propagation stays explicit", async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.databaseFile, { readOnly: true });
  const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map((r) => [r.key, r.value]));
  db.close();
  const results = [{ id: 'life', kind: 'value', catalog: 'Unit', entry: 'Dragoon', field: 'LifeMax', value: '123', status: 'complete', scope: 'CUnit' },
    { id: 'child-life', kind: 'value', catalog: 'Unit', entry: 'DragoonChild', field: 'LifeMax', value: '123', status: 'complete', scope: 'CUnit' },
    { id: 'abilities', kind: 'array', catalog: 'Unit', entry: 'Dragoon', field: 'AbilArray', member: 'Link', items: ['Move', 'OldSkill', 'Attack'], count: 3, status: 'complete', scope: 'CUnit' }];
  importEngineCatalog(f.databaseFile, { schemaVersion: 1, usable: true,
    run: { id: 'engine-integration', dependency: OFFICIAL_DEPENDENCY, buildInfoSha256: 'synthetic-install',
      context: { player: 0, missionInitialized: false, commanderInitialized: false, gameAPatchesLoaded: false },
      queries: results.map(({ id, kind, catalog, entry, field, member }) => ({ id, kind, catalog, entry, field, member })) },
    meta: { runId: 'engine-integration', status: 'complete', player: '0', context: 'official-catalog-no-mission-init-no-upgrades' },
    databaseMetadata: metadata, results, logs: [{ dataBuild: 'B97579', version: 'synthetic-test', diagnostics: [] }] });
  const observed = f.get();
  assert.equal(observed.effectiveField.field.value, 123);
  assert.equal(observed.effectiveField.field.valueSource, 'sc2-engine');
  assert.equal(observed.editState.edit.available, true, 'executor now consumes the same persisted engine baseline');
  assert.equal(observed.editState.edit.expect, 123);
  const ui = f.search().withProjectDatabase({ commanderId: 'Artanis' }, (database) => buildUnitProjection(database,
    { commanderId: 'ProtossArtanis', unit: { unitId: 'Dragoon', techId: 'Dragoon' } }));
  assert.equal(ui.stats.lifeMax, 123);
  await applyPlanToCore({ coreRoot: f.coreRoot, catalogRoot: path.join(path.dirname(f.databaseFile), 'merged/GameData'),
    plan: { id: 'engine-expect', operations: [{ kind: 'catalog.set', opId: 'life', catalog: 'Unit', object: 'Dragoon', path: 'LifeMax', expect: 123, value: 234 }] } });
  assert.equal(f.get().editState.edit.expect, 234, 'execution reads engine 123, not legacy XML 100');
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="456"/><AbilArray index="1" removed="1"/></CUnit>' });
  const current = f.get();
  assert.equal(current.effectiveField.field.value, 456);
  assert.equal(current.editState.officialBaseline.value, 123);
  assert.equal(current.editState.edit.expect, 456);
  assert.deepEqual(current.unitArrays.abilities.slots.map((s) => s.index), [0, 2]);
  const child = f.get('DragoonChild');
  assert.equal(child.editState.edit.available, false);
  assert.equal(child.editState.edit.reason, 'engine-baseline-parent-edited');
  assert.equal(child.editState.catalogEdit.available, false);
});

test("current state supplies executor expect/dependencies across sessions: Dragoon 100 -> 300 -> 200", async (t) => {
  const f = fixture(t);
  const beforeHash = hash(f.databaseFile);
  const operationFor = (fieldPath, value) => {
    const { edit } = f.get("Dragoon", fieldPath).editState;
    assert.equal(edit.available, true);
    return { ...edit.operation, opId: `set-${fieldPath.toLowerCase()}`, expect: edit.expect, value };
  };
  await f.apply("first-life", [operationFor("LifeMax", 300), operationFor("LifeStart", 300)]);
  const current = f.get();
  assert.equal(current.effectiveField.field.value, 300);
  assert.equal(current.editState.officialBaseline.value, 100);
  assert.equal(current.editState.coreCatalog.value, 100);
  assert.equal(current.editState.commanderPatch.value, 300);
  assert.equal(current.editState.edit.expect, 300);
  assert.equal(current.editState.catalogEdit.expect, 100);
  assert.deepEqual(current.editState.edit.requiredDependsOn, ["first-life"]);
  assert.equal(current.editState.runtimeValue.known, false);
  assert.equal(f.get("Dragoon", "LifeMax", "Raynor").effectiveField.field.value, 100);
  assert.equal(f.get("Dragoon", "LifeMax", null).effectiveField.field.value, 100);
  assert.equal(f.get("DragoonChild").effectiveField.field.value, 100, "player Upgrade must not inherit to child IDs");
  const ui = f.search().withProjectDatabase({ commanderId: "Artanis" }, (database) => {
    assert.throws(() => database.exec("UPDATE main.catalog_fields SET value='corrupted'"), /readonly/i);
    return buildUnitProjection(database, { commanderId: "ProtossArtanis", unit: { unitId: "Dragoon", techId: "Dragoon" } });
  });
  const commander = f.search().execute({ operation: "commander.get", commanderId: "Artanis", detailLevel: "full" });
  assert.equal(commander.roster.units[0].stats.lifeMax, 300);
  assert.deepEqual(commander.roster.units[0].stats, ui.stats);
  const second = [operationFor("LifeMax", 200), operationFor("LifeStart", 200)];
  await f.apply("second-life", second, current.editState.edit.requiredDependsOn);
  assert.equal(f.get().editState.edit.expect, 200);
  assert.deepEqual(f.get().editState.edit.requiredDependsOn, ["first-life", "second-life"]);
  assert.deepEqual((await f.apply("second-life", second, ["first-life"])).changedFiles, []);
  assert.equal(hash(f.databaseFile), beforeHash, "main database remains byte-for-byte unchanged");
});

test("executor itself rejects scope leakage and changed plan bytes without MCP", async (t) => {
  const f = fixture(t);
  const plan = { formatVersion: 2, id: "leak", title: "leak", target: "game-a.core",
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 },
    scope: { kind: "commander", commanderId: "ProtossArtanis" },
    isolation: { strategy: "player-upgrade" }, operations: [{ opId: "life", kind: "catalog.set",
      catalog: "Unit", object: "Dragoon", path: "LifeMax", expect: 100, value: 300 }] };
  write(f.repoRoot, "leak.json", plan);
  const before = hash(path.join(f.coreRoot, "Base.SC2Data/GameData.xml"));
  for (const check of [true, false]) await assert.rejects(executePatchPlan({ repoRoot: f.repoRoot,
    planPath: "leak.json", databaseFile: f.databaseFile, runGameAValidation: false, check }),
  (error) => error.review?.diagnostics.some((item) => item.code === "PLAYER_UPGRADE_HAS_STRUCTURAL_OPERATION"));
  await assert.rejects(executePatchPlan({ repoRoot: f.repoRoot, planPath: "leak.json",
    expectedPlanSha256: "0".repeat(64), runGameAValidation: false }), /content changed/);
  const { scope, isolation, ...unscoped } = plan;
  write(f.repoRoot, "unscoped.json", unscoped);
  await assert.rejects(executePatchPlan({ repoRoot: f.repoRoot, planPath: "unscoped.json",
    databaseFile: f.databaseFile, runGameAValidation: false }), /must declare scope and isolation/);
  // Existing local overrides must not turn an official ID into a private one.
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="100"/></CUnit>' });
  const pretendingPrivate = { ...plan, isolation: { strategy: "direct-private", owner: { catalog: "Unit", object: "Dragoon" } }, operations: [
    { opId: "fake-create", kind: "catalog.create", catalog: "Unit", object: "Dragoon", class: "CUnit" },
    ...plan.operations,
  ] };
  write(f.repoRoot, "pretend.json", pretendingPrivate);
  await assert.rejects(executePatchPlan({ repoRoot: f.repoRoot, planPath: "pretend.json",
    databaseFile: f.databaseFile, runGameAValidation: false }),
    (error) => error.review?.diagnostics.some((item) => item.code === "CREATED_ID_IS_OFFICIAL"));
  write(f.coreRoot, "Base.SC2Data/GameData.xml", "<Includes/>");
  assert.equal(hash(path.join(f.coreRoot, "Base.SC2Data/GameData.xml")), before);
});

test("postconditions read staged artifacts, not the operations claiming to create them", async (t) => {
  const f = fixture(t);
  const catalogRoot = path.join(path.dirname(f.databaseFile), "merged/GameData");
  const plan = { formatVersion: 2, id: "new-ability", title: "new-ability", target: "game-a.core",
    compatibility: { sc2DataBuild: "B97579", runtimeContract: 2 }, scope: { kind: "global" },
    isolation: { strategy: "global" }, operations: [
      { opId: "clone", kind: "catalog.clone", catalog: "Abil", object: "NewSkill", source: "OldSkill" },
      { opId: "attach", kind: "catalog.insert", catalog: "Unit", object: "Dragoon", path: "AbilArray", index: "5", attributes: { Link: "NewSkill" } },
    ], postconditions: [{ postId: "attached", kind: "unit.ability", unitId: "Dragoon", abilityId: "NewSkill" }] };
  write(f.repoRoot, "ability.json", plan);
  const checked = await executePatchPlan({ repoRoot: f.repoRoot, planPath: "ability.json",
    catalogRoot, check: true, runGameAValidation: false });
  assert.equal(checked.review.validationPhase, "staged-artifacts");
  assert.equal(checked.review.postconditions[0].status, "passed");
  const staged = path.join(f.repoRoot, "test-staged");
  cpSync(f.coreRoot, staged, { recursive: true });
  const application = await applyPlanToCore({ coreRoot: staged, plan, catalogRoot });
  await auditPatchArtifacts({ beforeCore: f.coreRoot, afterCore: staged, plan, application });
  const check = () => {
    const artifacts = openGameAArtifacts({ repoRoot: f.repoRoot, coreRoot: staged, databaseFile: f.databaseFile });
    try { return reviewPatchPlan(plan, { databaseFile: f.databaseFile, coreRoot: staged, artifacts }); }
    finally { artifacts.close(); }
  };
  assert.equal(check().postconditions[0].status, "passed");
  write(staged, "Base.SC2Data/GameData/UnitData.xml", '<Catalog><CUnit id="Dragoon"/></Catalog>');
  assert.equal(reviewPatchPlan(plan, { databaseFile: f.databaseFile, coreRoot: staged }).postconditions[0].status, "passed");
  assert.equal(check().postconditions[0].status, "failed");
  // A valid declared postcondition cannot conceal collateral writes.
  write(staged, "Base.SC2Data/GameData/UnitData.xml", '<Catalog><CUnit id="Dragoon"><AbilArray index="5" Link="NewSkill"/><LifeMax value="777"/></CUnit></Catalog>');
  assert.equal(check().postconditions[0].status, "passed");
  await assert.rejects(auditPatchArtifacts({ beforeCore: f.coreRoot, afterCore: staged, plan, application }),
    /Undeclared artifact field change: Unit\/Dragoon\/LifeMax/);
});

test("generated scalar value and activation are checked even without postconditions", async (t) => {
  const f = fixture(t);
  const operation = { kind: "commander.stat.set", opId: "life", commanderId: "ProtossArtanis",
    catalog: "Unit", object: "Dragoon", path: "LifeMax", expect: 100, value: 300 };
  const plan = { id: "audit-stat", operations: [operation] };
  const staged = path.join(f.repoRoot, "test-staged");
  cpSync(f.coreRoot, staged, { recursive: true });
  const application = await applyPlanToCore({ coreRoot: staged, plan,
    catalogRoot: path.join(path.dirname(f.databaseFile), "merged/GameData") });
  const audit = () => auditPatchArtifacts({ beforeCore: f.coreRoot, afterCore: staged, plan, application });
  await audit();
  const file = "Base.SC2Data/GameData/UpgradeData.xml";
  const correct = readFileSync(path.join(staged, file), "utf8");
  write(staged, file, correct.replace('Value="300"', 'Value="200"'));
  await assert.rejects(audit(), /does not match declared scoped writes/);
  write(staged, file, correct);
  const runtimeFile = application.changedFiles.find((file) => file.endsWith(".galaxy"));
  const source = readFileSync(path.join(staged, runtimeFile), "utf8");
  write(staged, runtimeFile, source.replaceAll("ProtossArtanis", "TerranRaynor"));
  await assert.rejects(audit(), /activation does not match declared commander/);
});

test("local clones, names, inheritance, slots and changed references share the projection", async (t) => {
  const f = fixture(t);
  f.catalog({
    Unit: `<CUnit id="LocalTempest" parent="Tempest"><LifeMax value="450"/><LifeStart value="450"/></CUnit>
      <CUnit id="Dragoon"><Speed value="3"/><AbilArray index="1" removed="1"/><AbilArray index="4" Link="NewSkill"/>
        <CardLayouts index="0"><LayoutButtons index="1" removed="1"/>
          <LayoutButtons index="4" Face="NewSkill" AbilCmd="NewSkill,Execute" Row="2" Column="2"/></CardLayouts>
      </CUnit>`,
    Abil: '<CAbilEffectInstant id="NewSkill"><Effect value="NewEffect"/></CAbilEffectInstant>',
    Effect: '<CEffectDamage id="NewEffect"><Amount value="25"/></CEffectDamage>',
  });
  write(f.coreRoot, "zhCN.SC2Data/LocalizedData/GameStrings.txt", "Unit/Name/LocalTempest=本地风暴战舰\n");
  const clone = f.get("LocalTempest");
  assert.equal(clone.entity.parentId, "Tempest");
  assert.equal(clone.editState.officialBaseline, null);
  assert.equal(clone.editState.edit.expect, 450);
  assert.equal(f.get("LocalTempest", "ShieldsMax").editState.edit.expect, 150);
  const resolution = f.search().execute({ operation: "entity.resolve", query: "本地风暴战舰", catalog: "Unit", commanderId: "Artanis" });
  assert.equal(resolution.candidates[0].objectId, "LocalTempest");
  assert.equal(resolution.candidates[0].commanderRelevance.relationship, "unresolved", "a parent is not proof of commander ownership");
  const unit = f.get();
  assert.deepEqual(unit.unitArrays.abilities.slots.map((slot) => slot.index), [0, 2, 4]);
  assert.deepEqual(unit.unitArrays.commandCards[0].slots.map((slot) => slot.index), [0, 2, 4]);
  assert.equal(unit.unitArrays.commandCards[0].nextFreeIndex, 5);
  const refs = f.search().execute({ operation: "catalog.references", catalog: "Unit", objectId: "Dragoon", direction: "outgoing" });
  assert(refs.outgoing.some((ref) => ref.targetObjectId === "NewSkill"));
  assert(!refs.outgoing.some((ref) => ref.targetObjectId === "OldSkill"));
  assert.equal(f.get("DragoonChild", "Speed").effectiveField.field.value, 3);
  assert.equal(f.get("DragoonChild", "Speed").editState.edit.available, false,
    "do not recommend a stale executor fallback when its cross-layer inheritance differs from the projection");
  const { edit } = clone.editState;
  await f.apply("clone-life", [{ ...edit.operation, opId: "clone-life", expect: edit.expect, value: 600 }]);
  assert.equal(f.get("LocalTempest").editState.edit.expect, 600);
});

test("current queries fail closed for malformed core, escaping includes and active transactions", async (t) => {
  const f = fixture(t);
  f.catalog({ Unit: '<CUnit id="Broken">' });
  assert.throws(() => f.get(), /XML|parse|end tag/i);
  write(f.repoRoot, "outside.xml", "<Catalog/>");
  write(f.coreRoot, "Base.SC2Data/GameData.xml", '<Includes><Catalog path="../../../../outside.xml"/></Includes>');
  assert.throws(() => f.get(), /escapes core/);
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="120"/></CUnit>' });
  const release = acquireGameALock(f.repoRoot);
  try { assert.throws(() => f.get(), /busy|locked|占用|正在/i); }
  finally { release(); }
  assert.equal(f.get().editState.edit.expect, 120);
});

test("ambiguous generated Upgrade identities do not report the official value as current", (t) => {
  const f = fixture(t);
  const operations = ["LifeMax", "lifemax"].map((fieldPath, index) => ({
    kind: "commander.stat.set", opId: `stat-${index}`, commanderId: "ProtossArtanis",
    catalog: "Unit", object: "Dragoon", path: fieldPath, value: 300 + index,
  }));
  f.catalog({ Upgrade: operations.map((operation) => {
    const { upgradeId, reference } = commanderStatIdentity(operation);
    return `<CUpgrade id="${upgradeId}"><EffectArray Reference="${reference}" Operation="Set" Value="${operation.value}"/></CUpgrade>`;
  }).join("") });
  write(f.repoRoot, "game-a/patches/ambiguous.patch-plan.json", { id: "ambiguous", operations });
  write(f.repoRoot, "game-a/patches/ambiguous.receipt.json", { planId: "ambiguous", operations });
  const result = f.get();
  assert.equal(result.editState.edit.available, false);
  assert.equal(result.editState.edit.reason, "multiple-scoped-upgrades");
  assert.equal(result.effectiveField.field, null);
  assert(result.currentProject.warnings.some((warning) => warning.code === "multiple-scoped-upgrades"));
});

test("missing historical plan does not hide the actual generated Upgrade value", async (t) => {
  const f = fixture(t);
  const operation = { kind: "commander.stat.set", opId: "life", commanderId: "ProtossArtanis",
    catalog: "Unit", object: "Dragoon", path: "LifeMax", expect: 100, value: 300 };
  await f.apply("missing-plan", [operation]);
  // Delete only this test fixture's stored plan; keep its receipt and core.
  rmSync(path.join(f.repoRoot, "game-a/patches/missing-plan.patch-plan.json"));
  const result = f.get();
  assert.equal(result.effectiveField.field.value, 300);
  assert.equal(result.editState.edit.expect, 300);
  assert.deepEqual(result.editState.edit.requiredDependsOn, ["missing-plan"]);
  assert(result.currentProject.warnings.some((warning) => warning.code === "applied-plan-unavailable"));
});

test("one snapshot cannot silently switch player scope and subsequent queries see new core values", (t) => {
  const f = fixture(t);
  const search = f.search();
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="120"/></CUnit>' });
  search.withProjectDatabase({ commanderId: "Artanis" }, () => {
    assert.throws(() => search.execute({ operation: "entity.get", catalog: "Unit", objectId: "Dragoon",
      commanderId: "Raynor", path: "LifeMax" }), /Cannot change commander scope/);
    assert.equal(search.execute({ operation: "entity.get", catalog: "Unit", objectId: "Dragoon",
      commanderId: "Artanis", path: "LifeMax" }).editState.edit.expect, 120);
  });
  f.catalog({ Unit: '<CUnit id="Dragoon"><LifeMax value="130"/></CUnit>' });
  assert.equal(search.execute({ operation: "entity.get", catalog: "Unit", objectId: "Dragoon",
    commanderId: "Artanis", path: "LifeMax" }).editState.edit.expect, 130);
});

test("exact queries keep all edit guards while arrays and graphs are explicit expansions", async (t) => {
  const f = fixture(t);
  const initial = f.get().editState.edit;
  await f.apply("compact-query", [{ ...initial.operation, opId: "life", expect: initial.expect, value: 300 }]);
  const query = { operation: "entity.get", catalog: "Unit", objectId: "Dragoon", commanderId: "Artanis", path: "LifeMax" };
  const compact = f.search().execute(query);
  const full = f.search().execute({ ...query, detailLevel: "full" });
  assert.deepEqual(compact.editState, full.editState);
  assert.deepEqual(compact.currentProject, full.currentProject);
  for (const key of ["fields", "effectiveField", "relationships", "unitArrays"]) assert.equal(key in compact, false);
  assert.equal(compact.editState.edit.expect, 300);
  assert.deepEqual(compact.editState.edit.requiredDependsOn, ["compact-query"]);
  assert(JSON.stringify(compact).length < JSON.stringify(full).length / 2);
  const slots = f.search().execute({ ...query, include: ["unitArrays"] });
  assert.deepEqual(slots.unitArrays, full.unitArrays);
  assert.equal("relationships" in slots, false);
  const unknown = f.search().execute({ ...query, path: "UnmodeledEngineDefault" });
  assert.equal(unknown.editState.edit.available, false);
  assert(unknown.fieldWarnings.some((warning) => warning.code === "engine-default-not-modeled"));
  assert.throws(() => f.search().execute({ ...query, include: ["not-supported"] }), /include must contain/);
});

test('MCP exact full request avoids dossiers while UI full and explicit evidence remain available', async t => {
  const f = fixture(t);
  const query = { operation: 'entity.get', catalog: 'Unit', objectId: 'Dragoon', commanderId: 'Artanis', path: 'LifeMax' };
  const search = f.search();
  const full = search.execute({ ...query, detailLevel: 'full', include: ['fields'] });
  const compact = executeScalarSearch(search, { ...query, detailLevel: 'full' });
  const tracedInput = executeScalarSearch(search, { ...query, detailLevel: 'full', include: ['fields'] });
  for (const result of [compact, tracedInput]) {
    assert.equal(result.fields, undefined);
    assert.equal(result.relationships, undefined);
    assert.equal(result.unitArrays, undefined);
    assert.deepEqual(result.editState.catalogEdit, full.editState.catalogEdit);
    assert.equal(result.editState.edit.expect, 100);
    assert.equal(result.responseMode, 'exact-field');
    assert(JSON.stringify(result).length < JSON.stringify(full).length / 2);
  }
  assert.equal(tracedInput.effectiveField.field.value, 100);
  assert.equal(compact.effectiveField, undefined);
  const initial = compact.editState.edit;
  await f.apply('mcp-compact-life', [{ ...initial.operation, opId: 'life', expect: initial.expect, value: 200 }]);
  const current = executeScalarSearch(f.search(), query);
  assert.equal(current.editState.edit.expect, 200);
  assert.deepEqual(current.editState.edit.requiredDependsOn, ['mcp-compact-life']);
  const graph = executeScalarSearch(f.search(), { ...query, include: ['relationships'] });
  assert(graph.relationships);
  assert.equal(graph.unitArrays, undefined);
  const graphOnly = executeScalarSearch(f.search(), { ...query, path: undefined, include: ['relationships'] });
  assert(graphOnly.relationships);
  assert.equal(graphOnly.fields, undefined);
  assert.equal(graphOnly.nextOffset, undefined);
  const dossier = executeScalarSearch(f.search(), { ...query, path: undefined, detailLevel: 'full' });
  assert(dossier.fields && dossier.relationships && dossier.unitArrays);
  const fieldsOnly = executeScalarSearch(f.search(), { ...query, path: undefined, detailLevel: 'full', include: ['fields'], limit: 1 });
  assert.equal(fieldsOnly.fields.length, 1);
  assert.equal(fieldsOnly.nextOffset, 1);
  assert.equal(fieldsOnly.relationships, undefined);
  assert.equal(fieldsOnly.unitArrays, undefined);
});
