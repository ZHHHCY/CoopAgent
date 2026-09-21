import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importEngineCatalog, attachEngineCatalog, engineCatalogStatus, fieldCoveredByEngine } from '../lib/engine-catalog-store.mjs';
import { OFFICIAL_DEPENDENCY } from '../lib/sc2-catalog-probe.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coop-engine-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES ('schemaVersion','2'),('sc2Build','BTEST'),('cascManifestSha256','synthetic-source');
    CREATE TABLE catalog_objects(catalog TEXT,object_id TEXT,class TEXT,parent_id TEXT,is_default INT,source_file TEXT,direct_xml TEXT,PRIMARY KEY(catalog,object_id));
    CREATE TABLE catalog_definitions(xml TEXT); INSERT INTO catalog_definitions VALUES ('lossless-synthetic-source');
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT,field_tag TEXT,attribute TEXT,source_file TEXT,origin_object_id TEXT,inheritance_depth INT,PRIMARY KEY(catalog,object_id,path));
    CREATE TABLE object_references(source_catalog TEXT,source_object_id TEXT,field_path TEXT,target_catalog TEXT,target_object_id TEXT,confidence REAL,evidence TEXT);
    INSERT INTO catalog_objects VALUES ('Unit','Sample','CUnit',NULL,0,'raw-source','<CUnit id="Sample"/>'),('Abil','Dash','CAbilEffectTarget',NULL,0,'raw-source','<CAbilEffectTarget id="Dash"/>');
    INSERT INTO catalog_objects VALUES ('Abil','Alpha','CAbil',NULL,0,'raw-source',''),('Abil','Beta','CAbil',NULL,0,'raw-source',''),('Effect','Teleport','CEffect',NULL,0,'raw-source','');
    INSERT INTO catalog_fields VALUES ('Unit','Sample','AbilArray.@Link','Beta','AbilArray','Link','raw-source','Sample',0),('Unit','Sample','LifeMax','100','LifeMax','value','raw-source','Sample',0);
    INSERT INTO catalog_fields VALUES ('Abil','Dash','Cost[#0].Cooldown.@TimeUse','10','Cooldown','TimeUse','raw-source','Dash',0),('Abil','Dash','Cost[0].Cooldown.@TimeUse','8','Cooldown','TimeUse','raw-source','Dash',0);
    INSERT INTO object_references VALUES ('Unit','Sample','AbilArray.@Link','Abil','Beta',1,'old-guess');`);
  db.close();
  return file;
}

function snapshot(id = 'test-1') {
  const results = [
    { id: 'abilities', kind: 'array', catalog: 'Unit', entry: 'Sample', field: 'AbilArray', member: 'Link', count: 2, items: ['Alpha', 'Beta'], status: 'complete', scope: 'CUnit' },
    { id: 'cooldown', kind: 'value', catalog: 'Abil', entry: 'Dash', field: 'Cost[0].Cooldown.TimeUse', value: '8', status: 'complete', scope: 'CAbilEffectTarget' },
    { id: 'effect', kind: 'array', catalog: 'Abil', entry: 'Dash', field: 'Effect', count: 1, items: ['Teleport'], status: 'complete', scope: 'CAbilEffectTarget' },
    { id: 'schema', kind: 'schema', catalog: 'Abil', entry: 'Dash', status: 'complete', scope: 'CAbilEffectTarget', schemas: [
      { scope: 'CAbilEffectTarget', count: 1, fields: [{ name: 'Effect', type: 'CEffectLink', category: 9, array: true, scope: true }] },
    ] },
  ];
  return { schemaVersion: 1, usable: true, run: { id, dependency: OFFICIAL_DEPENDENCY, buildInfoSha256: 'install-1',
    context: { player: 0, missionInitialized: false, commanderInitialized: false, gameAPatchesLoaded: false },
    queries: results.map(({ id, kind, catalog, entry, field, member }) => ({ id, kind, catalog, entry, field, member })) },
  meta: { runId: id, status: 'complete', player: '0', context: 'official-catalog-no-mission-init-no-upgrades' },
  databaseMetadata: { sc2Build: 'BTEST', cascManifestSha256: 'synthetic-source' },
  logs: [{ version: 'test', dataBuild: 'BTEST', diagnostics: [] }], results };
}

function read(file, callback, engine = true) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { if (engine) attachEngineCatalog(db); return callback(db); }
  finally { db.close(); }
}

test('old databases remain readable without a migration or engine cache', (t) => {
  const file = fixture(t);
  read(file, (db) => {
    assert.equal(engineCatalogStatus(db).coverage, 'none');
    assert.equal(db.prepare("SELECT value FROM catalog_fields WHERE path='LifeMax'").get().value, '100');
    assert.equal(attachEngineCatalog(db), attachEngineCatalog(db));
  });
});

test('import preserves source/legacy data and replaces covered fields and references only', (t) => {
  const file = fixture(t);
  const before = read(file, (db) => db.prepare('SELECT * FROM main.catalog_fields').all());
  assert.equal(importEngineCatalog(file, snapshot()).status, 'imported');
  read(file, (db) => {
    assert.deepEqual(db.prepare('SELECT * FROM main.catalog_fields').all(), before);
    assert.equal(db.prepare('SELECT xml FROM catalog_definitions').get().xml, 'lossless-synthetic-source');
    assert.deepEqual(db.prepare("SELECT value FROM catalog_fields WHERE catalog='Unit' AND path LIKE 'AbilArray%' ORDER BY path").all().map((r) => r.value), ['Alpha', 'Beta']);
    assert.equal(db.prepare("SELECT value FROM catalog_fields WHERE path='LifeMax'").get().value, '100');
    const cooldown = db.prepare("SELECT * FROM catalog_fields WHERE object_id='Dash' AND path LIKE 'Cost%'").all();
    assert.equal(cooldown.length, 1);
    assert.equal(cooldown[0].value, '8');
    assert.equal(cooldown[0].source_file, 'engine:test-1');
    assert.equal(db.prepare("SELECT count(*) AS n FROM object_references WHERE source_object_id='Sample'").get().n, 2);
    assert.equal(db.prepare("SELECT evidence FROM object_references WHERE target_object_id='Teleport'").get().evidence, 'engine-schema-link');
    assert.equal(engineCatalogStatus(db).coverage, 'partial');
  });
});

test('reimport is idempotent; a snapshot id cannot acquire different contents', (t) => {
  const file = fixture(t);
  const cache = snapshot();
  importEngineCatalog(file, cache);
  assert.equal(importEngineCatalog(file, cache).status, 'already-imported');
  cache.results[1].value = '9';
  assert.throws(() => importEngineCatalog(file, cache), /identity reused/);
  assert.equal(read(file, (db) => db.prepare('SELECT count(*) AS n FROM engine_snapshots').get().n), 1);
});

test('zero-length observed array removes old slots/edges without erasing unrelated fields', (t) => {
  const file = fixture(t);
  importEngineCatalog(file, snapshot());
  const cache = snapshot('test-2');
  cache.results[0].count = 0;
  cache.results[0].items = [];
  importEngineCatalog(file, cache);
  read(file, (db) => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM catalog_fields WHERE catalog='Unit' AND path LIKE 'AbilArray%'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM object_references WHERE source_catalog='Unit'").get().n, 0);
    assert.equal(db.prepare("SELECT value FROM catalog_fields WHERE path='LifeMax'").get().value, '100');
  });
});

test('wrong contexts, source builds, failed, stale and incomplete results roll back fully', (t) => {
  const file = fixture(t);
  const mutations = [
    (c) => { c.run.context.player = 1; },
    (c) => { c.run.context.gameAPatchesLoaded = true; },
    (c) => { c.databaseMetadata.cascManifestSha256 = 'other-source'; },
    (c) => { c.logs[0].dataBuild = 'other-build'; },
    (c) => { c.logs[0].diagnostics.push({ severity: 'error' }); },
    (c) => { c.meta.runId = 'old'; },
    (c) => { c.results[0].items.pop(); },
    (c) => { c.results[3].schemas[0].fields = []; },
    (c) => { c.results[0].field = 'OtherArray'; },
  ];
  for (const mutate of mutations) {
    const cache = snapshot(); mutate(cache);
    assert.throws(() => importEngineCatalog(file, cache), /rejected/);
  }
  assert.equal(read(file, (db) => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='engine_snapshots'").get().n), 0);
});

test('different installation context cannot be mixed with active snapshots', (t) => {
  const file = fixture(t);
  importEngineCatalog(file, snapshot());
  const next = snapshot('test-2');
  next.run.buildInfoSha256 = 'changed-install';
  assert.throws(() => importEngineCatalog(file, next), /context changed/);
  assert.equal(read(file, (db) => engineCatalogStatus(db).snapshots), 1);
});

test('Upgrade engine values cannot be joined to legacy references by ordinal alone',t=>{
  const file=fixture(t),db=new DatabaseSync(file);
  db.exec("INSERT INTO catalog_objects VALUES ('Upgrade','Research','CUpgrade',NULL,0,'raw-source','<CUpgrade id=\"Research\"/>'); INSERT INTO catalog_fields VALUES ('Upgrade','Research','EffectArray[#0].@Reference','Effect,Wrong,Amount','EffectArray','Reference','raw-source','Research',0)");db.close();
  const cache=snapshot('upgrade-identity');
  const set=results=>{cache.results=results;cache.run.queries=results.map(({id,kind,catalog,entry,field,member,maxItems})=>({id,kind,catalog,entry,field,member,maxItems}));};
  const base={catalog:'Upgrade',entry:'Research',status:'complete',scope:'CUpgrade'};
  set([{...base,id:'value',kind:'value',field:'EffectArray[0].Value',value:'13'}]);
  assert.throws(()=>importEngineCatalog(file,cache),/Reference\/Operation\/Value/);
  const arrays=['Reference','Operation','Value'].map((member,i)=>({...base,id:member.toLowerCase(),kind:'array',field:'EffectArray',member,count:1,items:[['Effect,Teleport,Amount','Add','13'][i]]}));
  set(arrays.slice(0,2));assert.throws(()=>importEngineCatalog(file,cache),/Reference\/Operation\/Value/);
  set(arrays);assert.equal(importEngineCatalog(file,cache).status,'imported');
  read(file,db=>{
    assert.equal(db.prepare("SELECT value FROM catalog_fields WHERE catalog='Upgrade' AND object_id='Research' AND path='EffectArray[0].Reference'").get().value,'Effect,Teleport,Amount');
    assert.equal(db.prepare("SELECT target_object_id FROM object_references WHERE source_catalog='Upgrade' AND source_object_id='Research'").get().target_object_id,'Teleport');
  });
});

test('coverage boundaries do not remove similarly named fields or sibling members', () => {
  const query = { kind: 'array', field: 'AbilArray', member: 'Link', count: 2 };
  assert.equal(fieldCoveredByEngine('AbilArray.@Link', query), true);
  assert.equal(fieldCoveredByEngine('AbilArray[#1].@Link', query), true);
  assert.equal(fieldCoveredByEngine('AbilArray[1].@Other', query), false);
  assert.equal(fieldCoveredByEngine('AbilArray[2].@Other', query), true);
  assert.equal(fieldCoveredByEngine('AbilArrayExtra[0].@Link', query), false);
});

test('array-member batches compose; a later scalar cannot discard proven siblings', (t) => {
  const file = fixture(t);
  importEngineCatalog(file, snapshot());
  const cache = snapshot('test-members');
  cache.results = [{ ...cache.results[0], id: 'other-member', member: 'Other', items: ['x', 'y'] }];
  cache.run.queries = cache.results.map(({ id, kind, catalog, entry, field, member }) => ({ id, kind, catalog, entry, field, member }));
  importEngineCatalog(file, cache);
  read(file, (db) => assert.equal(db.prepare("SELECT count(*) AS n FROM catalog_fields WHERE object_id='Sample' AND path LIKE 'AbilArray%'").get().n, 4));
  const scalar = structuredClone(cache);
  scalar.run.id = scalar.meta.runId = 'scalar-over-array';
  scalar.results = [{ id: 'one-link', kind: 'value', catalog: 'Unit', entry: 'Sample', field: 'AbilArray[0].Link', value: 'Alpha', status: 'complete', scope: 'CUnit' }];
  scalar.run.queries = scalar.results.map(({ id, kind, catalog, entry, field }) => ({ id, kind, catalog, entry, field }));
  assert.throws(() => importEngineCatalog(file, scalar), /array as a whole/);
  assert.equal(read(file, (db) => engineCatalogStatus(db).snapshots), 2);
});
