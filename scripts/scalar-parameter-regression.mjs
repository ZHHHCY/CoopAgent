#!/usr/bin/env node
// Observer-only: blind-fixture.mjs excludes files named *regression*.
// Same inputs, source snapshot, model and harness budgets in both arms.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAgentTestClient } from './lib/agent-test-client.mjs';
import { buildAgentProfile } from './lib/agent-profile.mjs';
import { createCoopSearch } from '../runtime/coop-mcp/lib/coop-search.mjs';
import { readRunUsage } from './agent-test-usage.mjs';
import { treeHash } from './lib/patch-plan-executor.mjs';
import { auditParameterRun } from './scalar-parameter-regression-report.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exec=promisify(execFile), json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function runProvenance(source,{profile,databaseFile,coreHash}) {
  const files={};
  async function collect(relative) {
    for(const entry of await fs.readdir(path.join(source,relative),{withFileTypes:true})) {
      const child=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.isDirectory()&&!['node_modules','__tests__'].includes(entry.name))await collect(child);
      else if(entry.isFile()&&/\.(mjs|json|md|ps1)$/.test(entry.name))
        files[child]=createHash('sha256').update(await fs.readFile(path.join(source,child))).digest('hex');
    }
  }
  for(const directory of ['scripts/lib','runtime/coop-mcp/lib','runtime/coop-mcp/prompts','docs/schemas','.opencode/skills','game-a/scripts'])await collect(directory);
  for(const file of ['opencode.json','runtime/coop-mcp/server.mjs','scripts/scalar-parameter-regression.mjs'])
    files[file]=createHash('sha256').update(await fs.readFile(path.join(source,file))).digest('hex');
  const digest=createHash('sha256');for await(const chunk of createReadStream(databaseFile))digest.update(chunk);
  return {profile,files,sourceDigest:createHash('sha256').update(JSON.stringify(files)).digest('hex'),databaseSha256:digest.digest('hex'),coreHash};
}
const cases=[
  {id:'life', prompt:'把蒙斯克皇家卫队中的劫掠者的基础生命上限和出生生命设为500。保留皇家卫队等级、经验、升级加成、费用、武器以及其他单位。',
    targets:['LifeMax','LifeStart'].map(p=>['TerranMengsk','Unit','MarauderMengsk',p,500]), controls:[['TerranMengsk','Unit','MarauderMengsk','Speed'],['TerranMengsk','Unit','MarauderMengsk','CostResource[Minerals]'],[null,'Unit','MarauderMengsk','LifeMax']]},
  {id:'vitals',prompt:'把阿塔尼斯龙骑士的基础生命上限和出生生命都设为300，基础护盾上限和出生护盾都设为200。保留研究、威望、精通加成及其他属性，不改其他单位。',
    targets:[...['LifeMax','LifeStart'].map(p=>['ProtossArtanis','Unit','Dragoon',p,300]),...['ShieldsMax','ShieldsStart'].map(p=>['ProtossArtanis','Unit','Dragoon',p,200])],
    controls:[['ProtossArtanis','Unit','Dragoon','Speed'],[null,'Unit','Dragoon','LifeMax'],[null,'Unit','Dragoon','ShieldsMax']]},
  {id:'damage',prompt:'只把雷诺陆战队的基础武器伤害提高50%，保留武器升级加成、攻击间隔、射程和其他属性。不能影响敌方或其他指挥官使用的同名单位和共享武器。',
    targets:[['TerranRaynor','Effect','GuassRifle','Amount',9]],controls:[[null,'Effect','GuassRifle','Amount'],['TerranSwann','Effect','GuassRifle','Amount'],['TerranRaynor','Weapon','GuassRifle','Period'],['TerranRaynor','Weapon','GuassRifle','Range']]},
  {id:'cooldown',prompt:'把雷诺休伯利安的大和炮技能基础冷却缩短50%，保留原来的升级加成，其他数值保持不变。',
    targets:[['TerranRaynor','Abil','HyperionVoidCoopYamatoCannon','Cost.Cooldown.@TimeUse',7.5]],controls:[[null,'Abil','HyperionVoidCoopYamatoCannon','Cost.Cooldown.@TimeUse'],['TerranRaynor','Unit','HyperionVoidCoop','LifeMax']]},
  {id:'continuous',requires:'life',prompt:'接着刚才的修改，把蒙斯克劫掠者的基础生命上限和出生生命各再增加50。其他内容保持原样。',
    targets:['LifeMax','LifeStart'].map(p=>['TerranMengsk','Unit','MarauderMengsk',p,550]),controls:[['TerranMengsk','Unit','MarauderMengsk','Speed'],[null,'Unit','MarauderMengsk','LifeMax']]},
  {id:'runtime-output',prompt:'把虚空碎片死亡之握造成的伤害从目标当前生命与护盾总和的75%改为50%。如果现有数值字段无法改变这个比例，就说明原因，不要修改无效的默认值。',
    targets:[],controls:[[null,'Effect','VoidShardACDeathGripDamageDummy','Amount']],negative:true},
];
const args=process.argv.slice(2), paid=args.includes('--run'), labelArg=args.indexOf('--label');
const onlyArg=args.indexOf('--only'), only=onlyArg>=0?args[onlyArg+1]:null;
if(only&&!cases.some(item=>item.id===only))throw Error('Unknown --only case.');
const label=labelArg>=0?args[labelArg+1]:'2026-09-19-scalar-parameters-v1';
if(!/^[a-z0-9-]+$/.test(label??''))throw Error('Use --label with a safe output directory name.');
if(!paid){console.log(JSON.stringify({usage:'node scripts/scalar-parameter-regression.mjs --run [--label name] [--only case]',cases},null,2));process.exit(0);}
const output=path.join(root,'outputs',label);
await fs.mkdir(output,{recursive:false});
const model=(await json(path.join(process.env.APPDATA,'CoopAgent/opencode-models.json'))).model;
if(!model)throw Error('No configured model.');
const state={model,startedAt:new Date().toISOString(),design:'Six paired requests, identical source/database/core/model and unchanged harness limits. Full parameter-profile replacement, not a single-variable ablation. No gameplay launch. One observation per case/profile; no statistical speed claim.',cases,results:[]};
const save=()=>fs.writeFile(path.join(output,'results.json'),JSON.stringify(state,null,2));
await save();
function query([commanderId,catalog,objectId,p]){return {operation:'entity.get',...(commanderId?{commanderId}:{}),catalog,objectId,path:p};}
function fields(fixture,items){const search=createCoopSearch({repoRoot:fixture.root,databaseFile:fixture.databaseFile,reuseSnapshots:true});
  try{return items.map(item=>{const result=search.execute(query(item));return {query:query(item),expected:item[4],value:result.editState?.edit?.expect,available:result.editState?.edit?.available};});}
  finally{search.close();}}
async function fixtureFor(profile){
  const {stdout}=await exec(process.execPath,['scripts/agent-test.mjs','init','--blind'],{cwd:root,windowsHide:true,timeout:120000,maxBuffer:1000000});
  const record=stdout.trim().split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(x=>x?.root);
  if(!record)throw Error('Fixture initialization did not return a project.');
  const fixture=await json(record.fixture), file=path.join(fixture.root,'opencode.json');
  await fs.writeFile(file,JSON.stringify(buildAgentProfile(await json(file),{profile}),null,2));
  await fs.writeFile(path.join(fixture.root,'AGENTS.md'),'# Isolated scalar experiment\nUse the configured Agent profile. Do not read parent projects, previous tests, credentials or observer data. Do not launch game/editor.\n');
  const auth=path.join(fixture.root,'../model-data/opencode/auth.json');
  await fs.mkdir(path.dirname(auth),{recursive:true});
  await fs.copyFile(path.join(process.env.USERPROFILE,'.local/share/opencode/auth.json'),auth);
  return {...fixture,auth};
}
const core=f=>path.join(f.root,'game-a/core/GameA.SC2Mod');
const completed=new Map();
let provenanceReady=false;
async function runCase(profile,scenario){
  const previous=scenario.requires?completed.get(profile+'-'+scenario.requires):null;
  if(scenario.requires&&!previous?.result?.pass){state.results.push({profile,id:scenario.id,skipped:'prior edit did not pass'});await save();return;}
  const fixture=previous?.fixture??await fixtureFor(profile);
  const result={profile,id:scenario.id,prompt:scenario.prompt,fixtureRoot:fixture.root};
  let client;
  try {
    const beforeHash=await treeHash(core(fixture));
    if(!provenanceReady){provenanceReady=true;state.provenance=await runProvenance(root,{profile:'workflow-vs-parameters',databaseFile:fixture.databaseFile,coreHash:beforeHash});await save();}
    result.initialCoreHash=beforeHash;
    result.before=fields(fixture,[...scenario.targets,...scenario.controls]);
    if(!scenario.negative&&result.before.some(f=>!f.available))throw Error('Observer cannot read a target/control; no model request made.');
    client=await createAgentTestClient({projectRoot:fixture.root});
    const start=Date.now();
    const started=await client.call('start',{prompt:scenario.prompt,sessionId:previous?.sessionId??null,taskId:previous?.taskId??null},{timeoutMs:30000});
    result.runId=started.run.runId;result.tracePath=started.run.tracePath;
    console.log(JSON.stringify({event:'started',profile,id:scenario.id,tracePath:result.tracePath}));
    let status,stopRequested=false;
    for(;;){
      status=await client.call('status',{}, {timeoutMs:30000});
      const live=['starting','running'].includes(status.run?.state);
      if(!live&&!status.busy){const jobs=(await client.call('jobs')).filter(j=>j.runId===result.runId);if(!jobs.some(j=>['submitted','applying'].includes(j.state))){result.jobs=jobs;break;}}
      if(Date.now()-start>600000&&!stopRequested){await client.call('stop',{runId:result.runId});stopRequested=true;}
      if(Date.now()-start>900000)throw Error('Host did not settle after cancellation; inspect recorded run.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    result.elapsedMs=Date.now()-start; result.state=status.run?.state; result.answer=status.run?.text;
    const events=(await fs.readFile(result.tracePath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    result.calls=events.filter(e=>e.event==='agent.tool.completed').map(e=>({...e.details,timestampMs:e.timestampMs}));
    result.usage=readRunUsage(result.tracePath,path.join(fixture.root,'../model-data/opencode/opencode.db'));
    result.toolCount=result.calls.length;
    result.errors=result.calls.filter(c=>c.error||c.output?.status==='error'||c.output?.isError);
    const writeTools=new Set(['coop_plan_prepare','coop_plan_submit','coop_scalar_change']);
    result.backendMs=result.calls.filter(c=>writeTools.has(c.tool)).reduce((sum,c)=>sum+Math.max(0,(c.providerTime?.end??0)-(c.providerTime?.start??0)),0);
    const firstWrite=events.find(e=>e.event==='agent.tool.started'&&writeTools.has(e.details?.tool));
    result.beforeWriteMs=firstWrite?firstWrite.timestampMs-start:null;
    result.after=fields(fixture,[...scenario.targets,...scenario.controls]);
    result.targetsPass=result.after.slice(0,scenario.targets.length).every(f=>f.available&&f.value===f.expected);
    result.controlsPass=result.after.slice(scenario.targets.length).every((f,i)=>f.available&&f.value===result.before[scenario.targets.length+i].value);
    result.finalCoreHash=await treeHash(core(fixture));
    result.writerEvidenceSeen=result.calls.some(c=>{const text=JSON.stringify(c.output);return text?.includes('VoidShardACDeathGripDamageDummy')&&text.includes('script-output');});
    if(scenario.negative)result.controlsPass=result.finalCoreHash===beforeHash;
    const negativePass=result.controlsPass&&result.writerEvidenceSeen&&/脚本|触发器|运行时/.test(result.answer??'')&&/覆盖|写入|计算/.test(result.answer??'')&&/不能|无法|不支持|未修改|没有修改/.test(result.answer??'');
    result.pass=result.controlsPass&&(scenario.negative?negativePass:result.targetsPass&&result.jobs.some(j=>j.state==='applied'));
    const taskEvent=events.findLast(e=>e.event==='task.phase.ended'||e.event==='task.delivery.saved');
    const task=taskEvent?.details?.task??taskEvent?.details;
    const sessionId=events.findLast(e=>e.event==='agent.session.discovered')?.details?.sessionId;
    Object.assign(result,auditParameterRun(result,events,{negative:scenario.negative}));
    completed.set(profile+'-'+scenario.id,{fixture,result,taskId:task?.id,sessionId});
    await fs.copyFile(result.tracePath,path.join(output,`${profile}-${scenario.id}.jsonl`));
  }catch(error){result.error=error.message;result.pass=false;}
  finally{if(client)await client.close();state.results.push(result);await save();}
  console.log(JSON.stringify({event:'finished',profile,id:scenario.id,pass:result.pass,ms:result.elapsedMs,error:result.error}));
}
// Sequential arms avoid competing for provider capacity. Alternate arm order.
for(const [index,scenario] of cases.entries())if(!only||scenario.id===only)for(const profile of index%2?['workflow','parameters']:['parameters','workflow'])await runCase(profile,scenario);
state.finishedAt=new Date().toISOString();await save();
for(const {fixture} of completed.values())await fs.rm(fixture.auth,{force:true});
const rows=state.results.map(r=>`| ${r.id} | ${r.profile} | ${r.skipped?'skipped':r.pass?'pass':'fail'} | ${r.elapsedMs==null?'—':(r.elapsedMs/1000).toFixed(1)} | ${r.toolCount??'—'} | ${r.usage?.recordedTotals?.total??'—'} | ${r.backendMs==null?'—':(r.backendMs/1000).toFixed(1)} |`);
await fs.writeFile(path.join(output,'report.md'),`# Scalar parameter interface paired trial\n\nModel: ${model}\n\n${state.design}\n\n| Case | Profile | Result | Seconds | Tools | Recorded tokens | Prepare/apply seconds |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\nPass requires independently read target/control values and an applied backend job. Runtime-output is a safe-gap negative, not a successful formula edit. Queries and assertions are observer-only; no IDs/paths/answers are supplied to the model. See results.json and per-run JSONL for original prompts, failures and usage coverage. No game validation is claimed.\n`);
console.log(JSON.stringify({event:'complete',output}));
