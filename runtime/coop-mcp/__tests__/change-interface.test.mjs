import test from 'node:test';
import assert from 'node:assert/strict';
import {changePlan,createChangeInterface,validateChangeInput} from '../lib/change-interface.mjs';
const baseline={schemaVersion:2,sc2:{dataBuild:'BSYNTH'}};
const input={id:'synthetic-change',summary:'Synthetic value',scope:{kind:'commander',commanderId:'Synthetic'},isolation:{strategy:'player-upgrade'},dependsOn:['previous'],
  operations:[{opId:'life',kind:'commander.stat.set',commanderId:'Synthetic',catalog:'Unit',object:'SyntheticUnit',path:'LifeMax',expect:100,value:120}]};
test('change envelope adds bookkeeping without choosing scope, targets, values or dependencies',()=>{
  const plan=changePlan(input,baseline);
  assert.equal(plan.formatVersion,2);assert.equal(plan.compatibility.sc2DataBuild,'BSYNTH');
  for(const k of ['scope','isolation','operations','dependsOn'])assert.deepEqual(plan[k],input[k]);
  assert.throws(()=>changePlan({...input,isolation:undefined},baseline),/explicit scope/);
  const advanced={...plan,customExtension:{keep:true},operations:[{kind:'catalog.clone',source:'X',object:'Y'}]};
  assert.deepEqual(changePlan({plan:advanced},baseline),advanced);
});
test('one change still checks, prepares and submits bound bytes; retry reuses preparation',async()=>{
  const calls=[];
  const change=createChangeInterface({baseline:async()=>baseline,check:p=>calls.push(['check',p]),core:{
    preparePlan:async({plan})=>{calls.push(['prepare',plan]);return {status:'prepared',preparationId:'bound'};},
    submitPlan:async p=>{calls.push(['submit',p]);return {status:'applied',preparationId:p.preparationId};},
  }});
  assert.equal((await change(input)).status,'applied');
  assert.deepEqual(calls.map(c=>c[0]),['check','prepare','submit']);
  assert.deepEqual(calls[2][1],{preparationId:'bound'});
  await change(input);assert.deepEqual(calls.map(c=>c[0]),['check','prepare','submit','submit']);
});
test('dry-run never submits; explicit resume still delegates to guarded submission',async()=>{
  let submitted=0;
  const change=createChangeInterface({baseline:async()=>baseline,core:{preparePlan:async()=>({preparationId:'bound',status:'prepared'}),submitPlan:async p=>{submitted++;return {status:'applied',...p};}}});
  assert.equal((await change({...input,dryRun:true})).status,'prepared');assert.equal(submitted,0);
  await change({preparationId:'bound'});assert.equal(submitted,1);
});
test('check, prepare and submit failures are not suppressed or converted into success',async()=>{
  for(const stage of ['check','prepare','submit']){
    let submitted=0;
    const change=createChangeInterface({baseline:async()=>baseline,check:()=>{if(stage==='check')throw Error('stale calculation');},core:{
      preparePlan:async()=>{if(stage==='prepare')throw Error('scope conflict');return {preparationId:'bound'};},
      submitPlan:async()=>{submitted++;throw Error('stale preparation');},
    }});
    await assert.rejects(change(input),/stale|scope/);assert.equal(submitted,stage==='submit'?1:0);
  }
});

test('ambiguous, malformed and unknown envelope fields cannot silently change intent',async()=>{
  let calls=0;
  const change=createChangeInterface({baseline:async()=>{calls++;return baseline;},core:{}});
  for(const invalid of [null,[],{...input,preparationId:'x'},{...input,plan:{}},{...input,dryRun:'true'},
    {...input,postconditions:[]},{...input,dependsOn:'previous'},{...input,operations:[]},{...input,isolation:null},{...input,summary:'x'.repeat(121)}]){
    await assert.rejects(change(invalid),error=>error.details?.stage==='input');
  }
  assert.equal(calls,0,'invalid input must not reach baseline/prepare/submit');
  assert.doesNotThrow(()=>validateChangeInput({...input,summary:'改'.repeat(120)}));
  assert.doesNotThrow(()=>validateChangeInput({plan:{custom:'retained for executor'},dryRun:true}));
});

test('submission observation errors preserve identity without claiming nothing was applied',async()=>{
  const change=createChangeInterface({baseline:async()=>baseline,core:{
    preparePlan:async()=>({preparationId:'bound'}),submitPlan:async()=>{throw Error('connection lost');},
  }});
  await assert.rejects(change(input),error=>{
    assert.equal(error.details.changeRecovery.applicationState,'unknown');
    assert.deepEqual(error.details.changeRecovery.resumeInput,{preparationId:'bound'});
    return true;
  });
});

test('stale cached preparation is evicted, but caller expect is never silently updated',async()=>{
  const prepared=[];let attempts=0;
  const change=createChangeInterface({baseline:async()=>baseline,core:{
    preparePlan:async({plan})=>{prepared.push(plan);return {preparationId:'bound-'+prepared.length};},
    submitPlan:async()=>{if(attempts++===0){const error=Error('context changed');error.code='preparation-stale';throw error;}return {status:'applied'};},
  }});
  await assert.rejects(change(input),error=>error.details.changeRecovery.action==='reinspect-current-values-and-prepare');
  await change(input);
  assert.equal(prepared.length,2);
  assert.equal(prepared[1].operations[0].expect,100);
});
