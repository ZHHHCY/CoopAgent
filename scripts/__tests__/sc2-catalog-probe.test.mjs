import test from 'node:test';
import assert from 'node:assert/strict';
import { generateProbe, parseProbeBank } from '../lib/sc2-catalog-probe.mjs';

const query = { id: 'sample', kind: 'array', catalog: 'Unit', entry: 'Example', field: 'WeaponArray', member: 'Link' };
const value = (name, text) => `<Key name="${name}"><Value string="${text}"/></Key>`;
const bank = (status = 'complete', id = 'test') => `<Bank version="1"><Section name="meta">${value('runId', id)}${value('status', status)}</Section><Section name="sample">${value('status', 'complete')}${value('count', '2')}${value('item0', 'Air')}${value('item1', 'Ground')}</Section></Bank>`;

test('probe uses official engine reads, isolated callbacks and local Bank output', () => {
  const source = generateProbe({ runId: 'test', bankName: 'CoopAgentProbe_test', queries: [query] });
  assert.match(source, /CatalogFieldValueGet\(catalog, entry, itemPath, 0\)/);
  assert.match(source, /TriggerExecute\(TriggerCreate\("ProbeQuery0"\)/);
  assert.match(source, /BankSave\(probeBank\)/);
  assert.doesNotMatch(source, /CatalogFieldValueSet|CatalogLinkReplace|GameA_Init|libCOOC_Init/);
});

test('bank parser preserves both array elements and identity', () => {
  const result = parseProbeBank(bank(), 'test', [query]);
  assert.deepEqual(result.results[0].items, ['Air', 'Ground']);
  assert.equal(result.results[0].count, 2);
  assert.equal(result.results[0].truncated, false);
});

test('rejects incomplete, stale, unrelated and malformed output', () => {
  assert.throws(() => parseProbeBank(bank('running'), 'test', [query]), /not completed/);
  assert.throws(() => parseProbeBank(bank('complete', 'older'), 'test', [query]), /runId/);
  assert.throws(() => parseProbeBank('<Other/>', 'test', [query]), /Invalid Bank/);
  assert.throws(() => parseProbeBank('<Bank><Broken></Bank>', 'test', [query]));
});

test('missing/aborted query is not interpreted as an empty successful result', () => {
  const result = parseProbeBank('<Bank><Section name="meta">' + value('runId', 'test') + value('status', 'complete') + '</Section></Bank>', 'test', [query]);
  assert.equal(result.results[0].status, 'missing');
  assert.equal(result.results[0].count, null);
});

test('unsafe identities and unsupported queries cannot inject Galaxy source', () => {
  assert.throws(() => generateProbe({ runId: 'bad"', bankName: 'safe' }), /identity/);
  assert.throws(() => generateProbe({ runId: 'safe', bankName: '../bad' }), /identity/);
  assert.throws(() => generateProbe({ runId: 'safe', bankName: 'safe', queries: [{ ...query, catalog: 'Injected()' }] }), /catalog/);
});

test('schema keeps unknown native types instead of inventing a Catalog relation', () => {
  const xml = '<Bank><Section name="meta">' + value('runId', 'test') + value('status', 'complete')
    + '</Section><Section name="sample">' + value('status', 'complete') + value('scope', 'CTest')
    + value('count', '1') + value('field0.name', 'Custom') + value('field0.type', 'UnknownNativeType')
    + value('field0.category', '-1') + value('field0.array', 'false') + value('field0.scope', 'true') + '</Section></Bank>';
  const result = parseProbeBank(xml, 'test', [{ ...query, kind: 'schema' }]);
  assert.deepEqual(result.results[0].schemas[0].fields[0], {
    name: 'Custom', type: 'UnknownNativeType', category: -1, array: false, scope: true,
  });
});

test('array safety cap is explicit, not disguised as a complete array', () => {
  const result = parseProbeBank(bank().replace('string="2"', 'string="300"'), 'test', [query]);
  assert.equal(result.results[0].count, 300);
  assert.equal(result.results[0].items.length, 256);
  assert.equal(result.results[0].truncated, true);
});

test('larger explicit array budget stays bounded and preserves every collected item',()=>{
  const large={...query,maxItems:512};
  const source=generateProbe({runId:'test',bankName:'safe',queries:[large]});
  assert.match(source,/"WeaponArray", "Link", 512\)/);
  const xml='<Bank><Section name="meta">'+value('runId','test')+value('status','complete')+'</Section><Section name="sample">'+value('status','complete')+value('count','300')+Array.from({length:300},(_,i)=>value(`item${i}`,`value${i}`)).join('')+'</Section></Bank>';
  const result=parseProbeBank(xml,'test',[large]).results[0];
  assert.equal(result.truncated,false);assert.equal(result.items.length,300);assert.equal(result.items[299],'value299');
  for(const maxItems of [0,1025,1.5,'512'])assert.throws(()=>generateProbe({runId:'test',bankName:'safe',queries:[{...query,maxItems}]}),/maxItems/);
});
