import test from 'node:test';
import assert from 'node:assert/strict';
import {pageScalarSearchBatch,expandScalarSearchBatchResult,scalarBatchQueries} from '../lib/scalar-search-view.mjs';

test('large batches page whole field evidence below the provider byte limit, without losing guards or queries',()=>{
  let queries=Array.from({length:32},(_,i)=>({commanderId:'Commander',catalog:'Upgrade',objectId:'Upgrade',path:`EffectArray[${i}].@Value`}));
  let results=queries.map((q,i)=>({editState:{edit:{available:true,expect:i,requiredDependsOn:['prior'],operation:{kind:'catalog.set',path:q.path}}},evidence:'中文'.repeat(900)}));
  const original=structuredClone(results),read=[];
  while(queries.length){
    const page=pageScalarSearchBatch(queries,results);
    assert(Buffer.byteLength(JSON.stringify(page))<=24000);
    assert(page.returned>0);
    read.push(...page.results.map(({input,...rest})=>rest));
    if(page.complete){assert.equal(page.nextQuery,undefined);break;}
    assert.deepEqual(page.nextQuery.queries,queries.slice(page.returned));
    queries=page.nextQuery.queries;results=results.slice(page.returned);
  }
  assert.deepEqual(read,original);
});

test('batch defaults preserve commander/prestige and cannot leak a default prestige into another commander',()=>{
  const q={catalog:'Unit',objectId:'Hero',path:'LifeMax'};
  const queries=scalarBatchQueries({commanderId:'A',prestigeUpgrade:'A-P2',queries:[q,{...q,commanderId:'B'},{...q,prestigeUpgrade:'A-P3'}]});
  assert.equal(queries[0].commanderId,'A');assert.equal(queries[0].prestigeUpgrade,'A-P2');
  assert.equal(queries[1].commanderId,'B');assert.equal(queries[1].prestigeUpgrade,undefined);
  assert.equal(queries[2].prestigeUpgrade,'A-P3');
});

test('shared batch context round-trips every field while distinct commander/condition evidence remains local',()=>{
  const queries=Array.from({length:12},(_,i)=>({catalog:'Upgrade',objectId:'U',path:`EffectArray[${i}].@Value`}));
  const results=queries.map((q,i)=>({database:{build:'BTEST',boundary:'x'.repeat(200)},currentProject:{commanderId:i===11?'Other':'Selected',prestigeUpgrade:i===10?'P2':null},
    fieldInfluences:{target:q,entries:[],coverage:{complete:false,missing:'runtime activation '.repeat(35)},taskPolicy:{note:'preserve unrelated research '.repeat(40)}},
    editState:{edit:{available:i!==11,expect:i,requiredDependsOn:['prior'],operation:{kind:'catalog.set',...q}}}}));
  const page=pageScalarSearchBatch(queries,results);
  assert.equal(page.complete,true);assert.ok(page.shared.database);assert.equal(page.shared.currentProject,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<Buffer.byteLength(JSON.stringify(results))*0.6);
  assert.deepEqual(page.results.map(r=>{const {input,...result}=expandScalarSearchBatchResult(page,r);return result;}),results);
  assert.equal(page.results[10].currentProject.prestigeUpgrade,'P2');assert.equal(page.results[11].editState.edit.available,false);
});

test('oversized single evidence is explicitly unavailable, with exact read recovery',()=>{
  const query={catalog:'Unit',objectId:'Hero',path:'LifeMax'};
  const page=pageScalarSearchBatch([query],[{editState:{evidence:'x'.repeat(25000)}}]);
  assert.equal(page.complete,false);
  assert.equal(page.results[0].status,'response-too-large');
  assert.equal(page.results[0].editState,undefined);
  assert.deepEqual(page.results[0].nextQuery,{operation:'entity.get',...query});
});

test('batch paging preserves exact field usage evidence unchanged',()=>{
  const query={commanderId:'ProtossFenix',catalog:'Effect',objectId:'AvengingProtocolAttackSpeedDummy',path:'Amount'};
  const usageEvidence={uses:['script-input'],readers:[{function:'ReadFenix',line:12}],coverage:{complete:false}};
  const result={responseMode:'exact-field',usageEvidence,currentProject:{commanderId:'ProtossFenix'}};
  const page=pageScalarSearchBatch([query],[result]);
  assert.deepEqual(expandScalarSearchBatchResult(page,page.results[0]).usageEvidence,usageEvidence);
});
