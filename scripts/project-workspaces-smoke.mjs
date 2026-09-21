// Local integration acceptance. Requires the user's already-built SC2 database;
// it never launches a model, the editor, or the game.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createProject, openProject } from './lib/project-workspaces.mjs';
import { APP_ROOT, projectEnvironment } from './lib/project-context.mjs';
import { treeHash } from './lib/patch-plan-executor.mjs';
import { createCoopAgentCore } from '../runtime/coop-mcp/lib/coop-agent-core.mjs';
import { createCoopSearch } from '../runtime/coop-mcp/lib/coop-search.mjs';
import { executeScalarSearch } from '../runtime/coop-mcp/lib/scalar-search-view.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'coop-project-live-'));
const a = await createProject({directory:path.join(root,'A'),name:'验收 A'});
const b = await createProject({directory:path.join(root,'B'),name:'验收 B'});
const source = project => path.join(project.workspaceRoot,'game-a/core/GameA.SC2Mod');
const initial = await treeHash(source(b));
const templateHash = await treeHash(path.join(a.templateRoot,'game-a/core/GameA.SC2Mod'));
function read(project, objectId='ScienceVessel') {
  const search = createCoopSearch({repoRoot:project.workspaceRoot,databaseFile:project.databaseFile});
  try { return executeScalarSearch(search,{operation:'entity.get',catalog:'Unit',objectId,path:'LifeMax',commanderId:'TerranSwann'}).editState; }
  finally { search.close(); }
}
const initialGoliath = read(a,'Goliath');
async function edit(id, value) {
  const current = read(a);
  const plan = {formatVersion:2,id,title:id,target:'game-a.core',compatibility:{sc2DataBuild:a.dataBuild,runtimeContract:a.runtimeContract},
    scope:{kind:'commander',commanderId:'TerranSwann'},isolation:{strategy:'player-upgrade'},userSummary:{text:'项目隔离验收：科学船生命参数'},
    dependsOn:current.edit.requiredDependsOn,operations:[{...current.edit.operation,opId:'life',expect:current.edit.expect,value}]};
  const core = createCoopAgentCore({repoRoot:a.workspaceRoot,runId:`run-${id}`});
  const prepared = await core.preparePlan({plan});
  const applied = await core.submitPlan({preparationId:prepared.preparationId});
  assert.equal(applied.status,'applied');
  assert.equal(read(a).edit.expect,value);
  assert.equal(read(b).edit.expect,200);
  assert.equal(await treeHash(source(b)),initial);
  return prepared.preparationId;
}
assert.equal(read(a).edit.expect,200);
const first=await edit('project-life-first',250);
assert.equal((await openProject(a.workspaceRoot)).projectId,a.projectId);
const second=await edit('project-life-second',read(a).edit.expect+20);
assert.deepEqual(read(a,'Goliath'),initialGoliath);
assert.equal(await treeHash(path.join(a.templateRoot,'game-a/core/GameA.SC2Mod')),templateHash);
const builds=[];
for (const project of [a,b]) {
  const built=await createCoopAgentCore({repoRoot:project.workspaceRoot}).buildGameA({});
  const pointer=JSON.parse(await readFile(path.join(project.workspaceRoot,'game-a/build/latest/oblivion-express.json')));
  assert.ok(built.status==='built');
  const summaries=spawnSync(process.execPath,[path.join(APP_ROOT,'runtime/coop-mcp/get-change-summaries.mjs')],{env:projectEnvironment(project.workspaceRoot),encoding:'utf8',windowsHide:true});
  assert.equal(summaries.status,0,summaries.stderr);
  const changes=JSON.parse(summaries.stdout);
  assert.equal(changes.items.length,project===a?2:0);
  builds.push({project:project.name,sourceHash:pointer.sourceHash,output:path.join(project.workspaceRoot,'game-a/build',pointer.output)});
}
assert.notEqual(builds[0].sourceHash,builds[1].sourceHash);
console.log(JSON.stringify({status:'passed',root,projectA:a.projectId,projectB:b.projectId,values:{A:270,B:200},preparations:[first,second],builds,gameValidated:false,modelValidated:false},null,2));
