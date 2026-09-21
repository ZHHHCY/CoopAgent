import assert from 'node:assert/strict';
import test from 'node:test';
import {readScopedBatch} from '../lib/scoped-read-batch.mjs';

test('batched reads reuse each exact scope, preserve order/errors and never cache across calls',()=>{
  const scopes=[];let active=null,revision=1;
  const search={withProjectDatabase(context,handler){assert.equal(active,null);active=context;scopes.push(context);
    try{return {...handler(),database:{revision}};}finally{active=null;}}};
  const inputs=[{commanderId:'A',target:'a'},{commanderId:'B',prestigeUpgrade:'P',target:'b'},
    {commanderId:'A',target:'bad'},{commanderId:'A',prestigeUpgrade:'P',target:'c'},{commanderId:'A',target:'d'}];
  const read=input=>{assert.equal(active.commanderId,input.commanderId);assert.equal(active.prestigeUpgrade,input.prestigeUpgrade);
    if(input.target==='bad')throw Error('unknown field');return {value:input.target};};
  const result=readScopedBatch(search,inputs,read);
  assert.equal(scopes.length,3);assert.deepEqual(result.map(x=>x.value),['a','b',undefined,'c','d']);
  assert.equal(result[2].status,'unsupported');assert.equal(result[2].error,'unknown field');
  revision=2;const next=readScopedBatch(search,inputs,read);assert.equal(scopes.length,6);
  assert.ok(next.every(x=>x.database.revision===2));
});

test('failure opening one scope is not a fabricated zero or loss of other scopes',()=>{
  const search={withProjectDatabase(c,fn){if(c.commanderId==='bad')throw Error('snapshot unavailable');return fn();}};
  const result=readScopedBatch(search,[{commanderId:'bad',target:'a'},{commanderId:'ok',target:'b'}],input=>({value:input.target}));
  assert.equal(result[0].status,'unsupported');assert.equal(result[0].value,undefined);assert.equal(result[1].value,'b');
});
