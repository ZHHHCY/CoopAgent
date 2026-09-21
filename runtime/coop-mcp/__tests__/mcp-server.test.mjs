import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { scalarSearchView, scalarSearchInput, executeScalarSearch, normalizeScalarSearchOperation, SCALAR_SEARCH_OPERATIONS } from '../lib/scalar-search-view.mjs';

test('default MCP exposes only the scalar workflow and rejects former mutation/research inputs', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const client = new Client({ name: 'scalar-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], cwd: root, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['plan_prepare', 'plan_submit', 'project_status', 'scalar_solve', 'search', 'search_batch', 'target_confirm', 'task_checkpoint']);
    const config = JSON.parse(await readFile(new URL('../../../opencode.json', import.meta.url), 'utf8'));
    const permissions = config.agent['coop-planner'].permission;
    for (const tool of tools) assert.equal(permissions[`coop_${tool.name}`], 'allow');
    assert.deepEqual(permissions.skill, { '*': 'deny', 'coop-scalar-change': 'allow', 'coop-query': 'allow' });
    assert.equal(permissions.read['*'], 'deny');
    assert.deepEqual(tools.find(t => t.name === 'search').inputSchema.properties.operation.enum, SCALAR_SEARCH_OPERATIONS);
    const usage = await readFile(new URL('../../../.opencode/skills/coop-query/search.md', import.meta.url), 'utf8');
    const validateExample = new Ajv({ strict: false }).compile(tools.find(t => t.name === 'search').inputSchema);
    const planInput=new Ajv({strict:false}).compile(tools.find(t=>t.name==='plan_prepare').inputSchema);
    const envelope={formatVersion:2,id:'synthetic-plan',title:'Synthetic',target:'game-a.core',compatibility:{sc2DataBuild:'BSYNTH',runtimeContract:2},
      operations:[{opId:'supporting',kind:'catalog.clone',catalog:'Effect',source:'SyntheticSource',object:'SyntheticPrivate'}]};
    assert(planInput({plan:envelope}),'typed envelope must not impose a scalar operation whitelist');
    assert(planInput({plan:{...envelope,formatVersion:1,operations:[{opId:'legacy',kind:'catalog.set',catalog:'Unit',object:'Synthetic',path:'LifeMax',expect:1,value:2}]}}),'v1 still reaches the authoritative executor');
    assert(validateExample({ operation:'entity.get', commanderId:'Synthetic', catalog:'Unit', objectId:'Scout', topic:'production' }));
    assert(validateExample({ operation:'entity.get', commanderId:'Synthetic', catalog:'Abil', objectId:'TrainA', commandIndex:'Train1' }));
    for(const topic of ['parameters','fields','influences']) assert(validateExample({operation:'entity.get',catalog:'Validator',objectId:'ConditionA',topic}));
    assert(validateExample({operation:'entity.get',catalog:'Unit',objectId:'Ship',path:'LifeMax',topic:'influences'}));
    for(const topic of ['prestiges','masteries','levelPerks','research','panelAbilities'])
      assert(validateExample({operation:'entity.get',commanderId:'Synthetic',catalog:'Commander',objectId:'A',topic}));
    assert(!validateExample({ operation:'semantic.get', commanderId:'Synthetic', query:'Scout' }));
    const examples = [...usage.matchAll(/```json\s*([\s\S]*?)```/g)];
    assert.equal(examples.length, 3);
    for (const [, source] of examples) assert(validateExample(JSON.parse(source)), JSON.stringify(validateExample.errors));
    for (const args of [
      { name:'search', arguments:{ query:'Scout' } },
      { name:'search', arguments:{ catalog:'Unit',objectId:'Scout',path:'LifeMax',query:'another target' } },
      { name:'search', arguments:{ operation:'semantic.get', commanderId:'Synthetic', objectId:'Scout' } },
      { name: 'search', arguments: { operation: 'experience.search', query: 'cloning' } },
      { name: 'patch_plan_write', arguments: { plan: {} } },
      { name: 'target_confirm', arguments: { question: '是这个吗？', target: '10级升级', currentEffect: '50%', proposedEffect: '25%', reason: '名字不同' } },
      { name: 'plan_prepare', arguments: { plan: { scope: { kind: 'global' } } } },
    ]) assert.equal((await client.callTool(args)).isError, true);
    const result = await client.callTool({ name: 'project_status', arguments: {} });
    assert.equal(result.structuredContent.developmentFocus, 'scalar-changes');
  } finally { await client.close(); }
});

test('missing operation recovers exact reads without guessing names, scope or writes', () => {
  const original={catalog:'Unit',objectId:'DroneStetmann',path:'LifeMax',commanderId:'ZergStetmann',prestigeUpgrade:'P2',include:['effectiveField']};
  const normalized=normalizeScalarSearchOperation(original);
  assert.deepEqual(normalized,{...original,operation:'entity.get'});
  assert.equal(original.operation,undefined);
  let received;
  const result=executeScalarSearch({execute(input){received=input;return{operation:input.operation,editState:{edit:{expect:60}}};}},original);
  assert.equal(received.operation,'entity.get');
  assert.equal(received.commanderId,original.commanderId);
  assert.equal(received.prestigeUpgrade,'P2');
  assert.equal(result.responseMode,'exact-field');
  assert.equal(result.editState.edit.expect,60);
  for(const input of [{},{query:'工蜂'},{objectId:'DroneStetmann',path:'LifeMax'}, {...original,query:'another'}, {...original,target:'another'}, {...original,topic:'influences'}, {...original,path:' '}, {...original,value:70}])
    assert.throws(()=>normalizeScalarSearchOperation(input),/Missing operation/);
  for(const operation of ['entity.resolve','requirement.explain','invalid',''])assert.equal(normalizeScalarSearchOperation({...original,operation}).operation,operation,'never override an explicit operation');
});

test('capabilities profile adds single-call change without removing advanced executor access',async()=>{
  const client=new Client({name:'capability-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),stderr:'pipe',env:{...process.env,COOPAGENT_TOOL_PROFILE:'capabilities'}});
  try{
    await client.connect(transport);
    const {tools}=await client.listTools();
    for(const name of ['change','search','scalar_solve','plan_prepare','plan_submit'])assert.ok(tools.some(t=>t.name===name));
    const change=tools.find(t=>t.name==='change').inputSchema.properties;
    assert.equal(change.scope.type,'object');assert.equal(change.isolation.properties.owner.type,'object');
    assert.deepEqual(change.isolation.properties.owner.required,['catalog','object']);
    const batch=new Ajv({strict:false}).compile(tools.find(t=>t.name==='search_batch').inputSchema);
    assert(batch({commanderId:'A',prestigeUpgrade:'P1',queries:[{catalog:'Unit',objectId:'One',path:'LifeMax'},{commanderId:'B',catalog:'Unit',objectId:'Two',path:'LifeMax'}]}));
    for(const input of [{id:'missing-scope'}, {preparationId:'x',id:'ambiguous'}, {plan:{},id:'ambiguous'}, {preparationId:'x',typo:'must not disappear'}])
      assert.equal((await client.callTool({name:'change',arguments:input})).isError,true);
  }finally{await client.close();}
});

test('active capability reference prioritizes scalar correctness without historical clone-first instructions',async()=>{
  const root=new URL('../../../',import.meta.url);
  const guide=await readFile(new URL('docs/scalar-capabilities.md',root),'utf8');
  const policy=await readFile(new URL('docs/commander-edit-policy.md',root),'utf8');
  for(const term of ['稳定交付','requiredDependsOn','prestigeUpgrade','Reference/Operation','prepared','submitted','applied','未改项'])assert.ok(guide.includes(term),term);
  assert.match(policy,/旧完整创作路线的兼容元数据/);
  assert.doesNotMatch(policy,/Agent 的默认路线是私有化|首批唯一新方案快捷规则|Agent 先读 `authoringRoute`/);
});

test('numeric guidance describes an outcome workflow with supporting edits, not an operation whitelist', async () => {
  const prompt = await readFile(new URL('../prompts/planner.md', import.meta.url), 'utf8');
  const skill = await readFile(new URL('../../../.opencode/skills/coop-scalar-change/SKILL.md', import.meta.url), 'utf8');
  assert.match(prompt, /保留无关行为和已有修改/);
  assert.match(prompt, /真实前置条件和原子提交检查/);
  assert.match(skill, /实现手段/);
  assert.match(skill, /实际承载它的字段/);
  assert.doesNotMatch(prompt + skill, /No global writes, clones|without adding Galaxy or clones|profile permits/);
});

test('workflow guidance makes parameter navigation primary, preserves escape paths and does not force edits for questions',async()=>{
  const base=new URL('../../../.opencode/skills/coop-scalar-change/',import.meta.url);
  const skill=await readFile(new URL('SKILL.md',base),'utf8');
  const calculation=await readFile(new URL('calculation.md',base),'utf8');
  const search=await readFile(new URL('../coop-query/search.md',base),'utf8');
  const prompt=await readFile(new URL('../prompts/planner.md',import.meta.url),'utf8');
  for(const token of ['objectCard','onThisObject','continueVia','conditions','fieldMeaning','commandIndex','primaryUpgrade','fieldsQuery','scalar_solve'])assert.ok((skill + search).includes(token),token);
  assert.doesNotMatch(skill,/parameterGuide|fieldGuide|生产入口是例外/);
  assert.match(skill,/停止“找字段”/);assert.match(skill,/不重复相同查询/);
  assert.match(skill,/不调用 plan_prepare 或 plan_submit/);
  assert.match(skill,/已有精确字段及含义则跳过字典浏览/);
  assert.match(skill,/调用后本轮结束/);assert.match(skill,/commanderId 不会自动隔离/);
  assert.match(calculation,/requiredDependsOn/);assert.match(calculation,/basis=current/);
  assert.match(prompt,/询问、解释和比较不授权写入/);
  assert.match(prompt,/根据当前任务自行选择/);
  assert.match(prompt,/不猜对象、字段、默认值或生效条件/);
  assert.match(prompt,/冲突先说明/);
  assert.match(prompt,/合作模式对象名册/);
  assert.match(prompt,/\| 单位 \| SCV \| `SCV` \|/);
  assert.match(prompt,/\| 单位 \| 帝国劳工 \| `SCVMengsk` \|/);
  assert.match(prompt,/合作模式指挥官面板技能对象说明/);
  assert.match(prompt,/\| 1 \| 休伯利安号 \| `SummonHyperionVoid` \| `VoidCoopSummonHyperion` \|/);
  assert.match(skill,/合作模式对象名册或面板技能表已经唯一确定/);
  const config=JSON.parse(await readFile(new URL('../../../opencode.json',import.meta.url),'utf8'));
  assert.equal(config.agent['coop-planner'].permission.read['.opencode/skills/coop-scalar-change/*'],'allow');
  assert.equal(config.agent['coop-planner'].permission.read['.opencode/skills/coop-query/*'],'allow');
  for (const name of ['coop-query','coop-scalar-change']) {
    assert.equal(config.agent['coop-planner'].permission.skill[name],'allow');
    const skillPath=`.opencode/skills/${name}/SKILL.md`;
    assert.ok(prompt.includes(skillPath));
    assert.ok((await readFile(new URL(`../../../${skillPath}`,import.meta.url),'utf8')).includes(`name: ${name}`));
  }
});

test('scalar query projection removes clone-first advice without rewriting current edit facts', () => {
  const original = { editState: { authoringRoute: { strategy: 'private-clone' }, edit: { expect: 100 } }, guidance: 'clone' };
  const view = scalarSearchView(original);
  assert.equal(view.editState.authoringRoute, undefined);
  assert.equal(view.editState.edit.expect, 100);
  assert.equal(view.authoringNote, undefined, 'policy belongs in the Skill, not every query response');
  assert.equal(original.editState.authoringRoute.strategy, 'private-clone');
});

test('object cards intern repeated provenance without losing evidence or mutating the read model',()=>{
  const source={file:'synthetic.xml',originObjectId:'Parent',inheritanceDepth:1};
  const result={operation:'entity.get',objectCard:{entries:[{path:'LifeMax',source},{via:{path:'AbilArray[0].@Link'},
    source,alsoVia:[{source,command:'Execute'}]}]}};
  const before=structuredClone(result),view=scalarSearchView(result);
  assert.deepEqual(result,before);assert.deepEqual(view.objectCard.sources,[source]);
  assert.deepEqual(view.objectCard.sources[view.objectCard.entries[0].sourceIndex],source);
  assert.equal(view.objectCard.entries[1].alsoVia[0].sourceIndex,0);
  assert.deepEqual(scalarSearchView(view),view,'compacting twice must not drop provenance');
});

test('MCP exact field and explicit parts take precedence over full without changing caller input', () => {
  const input = { operation: 'entity.get', path: 'LifeMax', detailLevel: 'full', include: ['fields'] };
  const query = scalarSearchInput(input);
  assert.deepEqual(query.include, ['effectiveField']);
  assert.equal(query.detailLevel, 'overview');
  assert.equal(input.detailLevel, 'full');
  assert.deepEqual(input.include, ['fields']);
  assert.deepEqual(scalarSearchInput({ ...input, include: undefined }).include, []);
  assert.deepEqual(scalarSearchInput({ ...input, include: ['relationships'] }).include, ['relationships']);
  assert.equal(scalarSearchInput({ operation: 'entity.get', detailLevel: 'full' }).detailLevel, 'full');
  assert.equal(scalarSearchInput({ operation: 'entity.get', detailLevel: 'full', include: ['fields'] }).detailLevel, 'overview');
  assert.equal(scalarSearchInput({ operation: 'commander.get', detailLevel: 'full' }).detailLevel, 'full');
  let received;
  executeScalarSearch({ execute(q) { received = q; return { operation: q.operation }; } }, input);
  assert.deepEqual(received, query);
});

test('MCP compact response keeps guards, provenance, ambiguity and warnings without mutation', () => {
  const original = { operation: 'entity.get', database: { sc2Build: 'B1', engineCatalog: { coverage: 'partial', unobserved: 'unknown', objects: 500 } },
    currentProject: { commanderId: 'A', prestigeUpgrade: 'P2', baseline: { objects: 500 }, warnings: ['unsafe'], runtimeValuesEvaluated: false },
    editState: { officialBaseline: { value: 100, valueSource: 'legacy-interpreted' }, coreCatalog: { value: 200 },
      commanderPatch: { planId: 'old' }, scope: { kind: 'commander' }, runtimeValue: { known: false },
      edit: { available: false, reason: 'multiple-scoped-upgrades', requiredDependsOn: ['old'], recommended: false },
      catalogEdit: { available: true, expect: 200, targets: ['x'] } },
    fieldWarnings: ['unverified'], effectiveField: { ambiguous: true, alternatives: [{ value: 100 }, { value: 200 }] } };
  const before = structuredClone(original);
  const view = scalarSearchView(original, { path: 'LifeMax' });
  assert.deepEqual(original, before);
  assert.deepEqual(view.editState.catalogEdit, original.editState.catalogEdit);
  assert.deepEqual(view.editState.officialBaseline, original.editState.officialBaseline);
  assert.deepEqual(view.editState.edit.requiredDependsOn, ['old']);
  assert.equal(view.editState.edit.available, false);
  assert.deepEqual(view.effectiveField, original.effectiveField);
  assert.deepEqual(view.currentProject.warnings, ['unsafe']);
  assert.deepEqual(view.fieldWarnings, ['unverified']);
  assert.equal(view.currentProject.prestigeUpgrade, 'P2');
  assert.equal(view.database.engineCatalog.coverage, 'partial');
  assert.equal(view.currentProject.baseline, undefined);
});

test('oversized pages are re-read with honest pagination instead of transport truncation',()=>{
  const queries=[];
  const search={execute(q){queries.push(q);const offset=q.offset??0,limit=q.limit??30;
    return {operation:'entity.get',objectCard:{total:40,offset,nextOffset:offset+limit,
      nextQuery:{...q,offset:offset+limit},entries:Array.from({length:limit},(_,i)=>({path:`Field[${offset+i}]`,value:'x'.repeat(2000)}))}};
  }};
  const result=executeScalarSearch(search,{operation:'entity.get',catalog:'Unit',objectId:'Synthetic',limit:30});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<24000);
  assert.equal(result.objectCard.nextOffset,result.objectCard.entries.length);
  assert.equal(result.objectCard.total,40);assert.ok(queries.length>1);
  assert.equal(result.outputLimit.reason,'response-byte-budget');
  const huge=executeScalarSearch({execute(){return {operation:'entity.get',fields:[{value:'x'.repeat(40000)}]};}},
    {operation:'entity.get',catalog:'Unit',objectId:'Synthetic',path:'Huge'});
  assert.equal(huge.status,'response-too-large');assert.equal(huge.query.path,'Huge');
});

test('influence byte budget retains conditions, guards and executable continuation',()=>{
  const input={operation:'entity.get',catalog:'Unit',objectId:'Ship',commanderId:'A',prestigeUpgrade:'P2',path:'LifeMax',topic:'influences',limit:8};
  const search={execute(q){const limit=q.limit,offset=q.offset??0;return {
    operation:'entity.get',responseMode:'field-influences',editState:{catalogEdit:{expect:200}},
    fieldInfluences:{runtimeEvaluated:false,coverage:{complete:false},total:16,offset,
      entries:Array.from({length:limit},(_,i)=>({objectId:`U${offset+i}`,conditions:[{activationVerified:false,evidence:'x'.repeat(4000)}]})),
      nextQuery:{...input,offset:offset+limit,limit}},
  };}};
  const result=executeScalarSearch(search,input);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<24000);
  assert.equal(result.responseMode,'field-influences');
  assert.equal(result.fieldInfluences.total,16);
  assert.equal(result.fieldInfluences.coverage.complete,false);
  assert.equal(result.fieldInfluences.nextQuery.offset,result.fieldInfluences.entries.length);
  assert.equal(result.fieldInfluences.nextQuery.path,'LifeMax');
  assert.equal(result.fieldInfluences.nextQuery.prestigeUpgrade,'P2');
  assert.equal(result.fieldInfluences.entries[0].conditions[0].evidence.length,4000);
  assert.equal(result.editState.catalogEdit.expect,200);
});
