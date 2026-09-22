import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat, rename, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProject, openProject, openOrMigrateProject, renameProject, migrateProject, verifyTemplate } from '../lib/project-workspaces.mjs';
import { APP_ROOT } from '../lib/project-context.mjs';
import { treeHash } from '../lib/patch-plan-executor.mjs';
import { createPlanSubmissionService } from '../lib/plan-submission.mjs';
import { createAgentTaskStore } from '../lib/agent-task.mjs';
import { buildCascDatabase } from '../lib/casc-database-builder.mjs';

const core = root => path.join(root, 'game-a/core/GameA.SC2Mod');
const templateRoot = path.join(APP_ROOT, 'game-a/templates/coop-default-v1/7');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'coop-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await createProject({directory:path.join(root,'A'),name:'A'});
  const b = await createProject({directory:path.join(root,'B'),name:'B'});
  return {root,a,b};
}
test('default template has no catalog overrides or historical feature modules; projects are independent regular files', async t => {
  const {a,b} = await fixture(t);
  assert.notEqual(a.projectId,b.projectId);
  assert.equal(a.templateHash,b.templateHash);
  const manifest=JSON.parse(await readFile(path.join(core(a.workspaceRoot),'GameA.Core.json')));
  assert.deepEqual(manifest.galaxy.modules.map(module=>module.path),[
    'Base.SC2Data/GameAIntegration.galaxy',
    'Base.SC2Data/Generated/CommanderPreparation.galaxy',
    'Base.SC2Data/Generated/PreparationOptions.galaxy',
    'Base.SC2Data/Generated/MutatorSelection.galaxy',
    'Base.SC2Data/Generated/TestMode.galaxy',
  ]);
  assert.equal(manifest.galaxy.modules.find(module=>module.path.endsWith('/TestMode.galaxy')).postMissionStart,
    'GameA_TestModeApplyStartingEconomy');
  const galaxySources=await Promise.all([
    ...manifest.galaxy.modules.map(module=>readFile(path.join(core(a.workspaceRoot),module.path),'utf8')),
    readFile(path.join(core(a.workspaceRoot),manifest.galaxy.core),'utf8'),
    readFile(path.join(APP_ROOT,'game-a/projects/GameA-OblivionExpress.SC2Map/scripts/GameAOblivionExpressAdapter.galaxy'),'utf8'),
  ]);
  const joined=galaxySources.join('\n');
  const definitions=new Set(Array.from(joined.matchAll(/^\s*(?:void|bool|int|fixed|string|unit|trigger|timer|point|unitgroup|playergroup|text)\s+(GameA_[A-Za-z0-9_]+)\s*\(/gm),match=>match[1]));
  for(const generated of ['GameA_GeneratedInit','GameA_GeneratedConfigureCommander','GameA_GeneratedBeforeMissionStart','GameA_GeneratedPostMissionStart']) definitions.add(generated);
  const references=new Set(Array.from(joined.matchAll(/\bGameA_[A-Za-z0-9_]+\b/g),match=>match[0]));
  assert.deepEqual([...references].filter(name=>!definitions.has(name)).sort(),[]);
  for (const folder of [core(a.workspaceRoot),core(b.workspaceRoot),core(templateRoot)]) {
    for (const file of await readdir(path.join(folder,'Base.SC2Data/GameData'))) {
      assert.match(await readFile(path.join(folder,'Base.SC2Data/GameData',file),'utf8'), /<Catalog\/>/);
      assert.equal((await stat(path.join(folder,'Base.SC2Data/GameData',file))).nlink,1);
    }
  }
  assert.equal(await treeHash(core(a.workspaceRoot)),await treeHash(core(b.workspaceRoot)));
  assert.equal((await readdir(path.join(a.workspaceRoot,'game-a/patches'))).length,0);
  assert.equal((await readdir(path.join(a.workspaceRoot,'.coopagent/opencode'))).length,0);
});
test('A edits and receipts survive reopening and continuous editing; B and template remain unchanged; cross-project identities fail', async t => {
  const {root,a,b} = await fixture(t);
  const before=await treeHash(core(templateRoot));
  const put=async (file,content)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);};
  await put(path.join(root,'casc/manifest.json'),JSON.stringify({source:{version:'synthetic'}}));
  await put(path.join(root,'casc/files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata/unitdata.xml'),'<Catalog><CUnit id="ScienceVessel"><LifeMax value="200"/></CUnit><CUnit id="Other"><LifeMax value="75"/></CUnit></Catalog>');
  const {databaseFile}=buildCascDatabase({cascRoot:path.join(root,'casc'),output:path.join(root,'database')});
  const catalogRoot=path.join(root,'database/merged/GameData');
  const service=who=>createPlanSubmissionService({repoRoot:who.workspaceRoot,runGameAValidation:false});
  const plan=(id,expect,value)=>({formatVersion:2,id,dependsOn:id==='first'?[]:['first'],title:id,target:'game-a.core',userSummary:{text:'科学船生命调整'},compatibility:{sc2DataBuild:'B97579',runtimeContract:2},scope:{kind:'global'},isolation:{strategy:'global'},operations:[{opId:'life',kind:'catalog.set',catalog:'Unit',object:'ScienceVessel',path:'LifeMax',expect,value}]});
  async function prepare(who,id,expect,value){return service(who).prepare({planContent:plan(id,expect,value),planPath:`game-a/drafts/${id}.patch-plan.json`,databaseFile,catalogRoot,runId:`run-${id}`});}
  const first=await prepare(a,'first',200,250);
  await assert.rejects(service(b).submit({preparationId:first.preparationId}),/Unknown preparationId/);
  const applied=await service(a).submit({preparationId:first.preparationId});
  assert.equal(applied.report.receipt.projectId,a.projectId);
  assert.equal(applied.report.receipt.source.runId,'run-first');
  const reopened=await openProject(a.workspaceRoot);
  const second=await prepare(reopened,'second',250,270);
  await service(reopened).submit({preparationId:second.preparationId});
  const xml=await readFile(path.join(core(a.workspaceRoot),'Base.SC2Data/GameData/UnitData.xml'),'utf8');
  assert.match(xml,/LifeMax value="270"/); assert.doesNotMatch(xml,/id="Other"/);
  assert.equal(await treeHash(core(b.workspaceRoot)),before);
  assert.equal(await treeHash(core(templateRoot)),before);
  assert.equal((await readdir(path.join(a.workspaceRoot,'game-a/patches'))).filter(x=>x.endsWith('.receipt.json')).length,2);
  createAgentTaskStore(a.workspaceRoot).begin({id:'task-a',runId:'run-a',prompt:'修改科学船'});
  assert.equal(createAgentTaskStore(b.workspaceRoot).get({id:'task-a'}),null);
  assert.throws(()=>createAgentTaskStore(b.workspaceRoot).begin({id:'task-b',runId:'run-b',prompt:'继续',resumeId:'task-a'}),/Unknown|not found/i);
  await assert.rejects(prepare(a,'stale',200,300));
  assert.match(await readFile(path.join(core(a.workspaceRoot),'Base.SC2Data/GameData/UnitData.xml'),'utf8'),/LifeMax value="270"/);
});
test('rename, moving directories and incompatible templates preserve identity without resetting source', async t=>{
  const {root,a}=await fixture(t);
  const renamed=await renameProject(a.workspaceRoot,'新名称');
  assert.equal(renamed.projectId,a.projectId); assert.equal(renamed.name,'新名称');
  const moved=path.join(root,'moved');await rename(a.workspaceRoot,moved);
  assert.equal((await openProject(moved)).projectId,a.projectId);
  const file=path.join(moved,'coop-project.json'); const manifest=JSON.parse(await readFile(file));
  manifest.templateHash='wrong';await writeFile(file,JSON.stringify(manifest));
  await assert.rejects(openProject(moved),/不兼容/);
  await assert.rejects(createProject({directory:moved,name:'overwrite'}),/已存在/);
  assert.equal(await treeHash(core(moved)),await treeHash(core(templateRoot)));
  const damaged=path.join(root,'template');await cp(templateRoot,damaged,{recursive:true});
  await writeFile(path.join(core(damaged),'Base.SC2Data/GameData/UnitData.xml'),'<Catalog><CUnit id="Bad"/></Catalog>');
  await assert.rejects(verifyTemplate(damaged),/已改变/);
});
test('explicit migration updates the template binding without replacing project edits', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'coop-project-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=await createProject({directory:path.join(root,'project'),name:'迁移'});
  const manifestPath=path.join(project.workspaceRoot,'coop-project.json');
  const manifest=JSON.parse(await readFile(manifestPath));
  const previousRoot=path.join(APP_ROOT,'game-a/templates/coop-default-v1/1');
  const previous=JSON.parse(await readFile(path.join(previousRoot,'template.json')));
  await cp(path.join(previousRoot,'game-a/core/GameA.SC2Mod'),core(project.workspaceRoot),{recursive:true,force:true});
  const marker=path.join(core(project.workspaceRoot),'Base.SC2Data/GameData/UnitData.xml');
  const customizedLocalization=path.join(core(project.workspaceRoot),'zhCN.SC2Data/LocalizedData/GameStrings.txt');
  await writeFile(marker,'<Catalog><CUnit id="Kept"/></Catalog>');
  await writeFile(customizedLocalization,'GameA/Preparation/DialogTitle=自定义标题\n');
  manifest.templateVersion=previous.templateVersion;
  manifest.templateHash=(await verifyTemplate(previousRoot, APP_ROOT).catch(()=>null))?.templateHash
    ?? createHash('sha256').update(JSON.stringify({files:previous.files,sharedInputs:previous.sharedInputs ?? {}})).digest('hex');
  await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
  const migrated=await migrateProject(project.workspaceRoot);
  assert.equal(migrated.templateVersion,'7');
  assert.equal(await readFile(marker,'utf8'),'<Catalog><CUnit id="Kept"/></Catalog>');
  assert.equal(await readFile(customizedLocalization,'utf8'),'GameA/Preparation/DialogTitle=自定义标题\n');
  assert.match(await readFile(path.join(core(project.workspaceRoot),'enUS.SC2Data/LocalizedData/GameStrings.txt'),'utf8'),/CoopAgent Map Runtime/);
  assert.match(await readFile(path.join(core(project.workspaceRoot),'Base.SC2Data/Generated/PreparationOptions.galaxy'),'utf8'),/GameA_PreparationOptionsApplyAfterMissionInit/);
  assert.match(await readFile(path.join(core(project.workspaceRoot),'Base.SC2Data/Generated/PreparationOptions.galaxy'),'utf8'),/PlayerSetDifficulty\(4, gameA_selectedDifficulty\)/);
  const migratedCore=JSON.parse(await readFile(path.join(core(project.workspaceRoot),'GameA.Core.json')));
  assert.equal(migratedCore.galaxy.modules.find(module=>module.path.endsWith('/PreparationOptions.galaxy')).beforeMissionStart,
    'GameA_PreparationOptionsApplyAfterMissionInit');
  assert.equal(migratedCore.galaxy.modules.find(module=>module.path.endsWith('/TestMode.galaxy')).postMissionStart,
    'GameA_TestModeApplyStartingEconomy');
});
test('desktop open migrates an older project before current shared-host verification', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'coop-project-auto-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=await createProject({directory:path.join(root,'project'),name:'自动迁移'});
  const manifestPath=path.join(project.workspaceRoot,'coop-project.json');
  const manifest=JSON.parse(await readFile(manifestPath));
  const previousRoot=path.join(APP_ROOT,'game-a/templates/coop-default-v1/6');
  const previous=JSON.parse(await readFile(path.join(previousRoot,'template.json')));
  await cp(path.join(previousRoot,'game-a/core/GameA.SC2Mod'),core(project.workspaceRoot),{recursive:true,force:true});
  const marker=path.join(core(project.workspaceRoot),'Base.SC2Data/GameData/UnitData.xml');
  await writeFile(marker,'<Catalog><CUnit id="KeptDuringAutoMigration"/></Catalog>');
  manifest.templateVersion=previous.templateVersion;
  manifest.templateHash=createHash('sha256').update(JSON.stringify({files:previous.files,sharedInputs:previous.sharedInputs ?? {}})).digest('hex');
  await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);

  await assert.rejects(openProject(project.workspaceRoot),/模板共享宿主已改变，需显式迁移/);
  const opened=await openOrMigrateProject(project.workspaceRoot);
  assert.equal(opened.templateVersion,'7');
  assert.equal(await readFile(marker,'utf8'),'<Catalog><CUnit id="KeptDuringAutoMigration"/></Catalog>');
  assert.match(await readFile(path.join(core(project.workspaceRoot),'enUS.SC2Data/LocalizedData/GameStrings.txt'),'utf8'),/CoopAgent Map Runtime/);
});
