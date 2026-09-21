import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CoopSearchError, createCoopSearch } from "../lib/coop-search.mjs";
import { reindexGalaxySymbols } from "../../../scripts/lib/galaxy-symbols.mjs";
import { executeScalarSearch } from '../lib/scalar-search-view.mjs';
import { buildCoopSemantics } from '../../../scripts/lib/coop-semantics.mjs';
import { validatePrestigeContract } from '../../../scripts/lib/prestige-contract.mjs';

test('default cards, exact reads and field pages expose field influences without another tool call', async () => {
  const fixture=await createFixture(),db=new DatabaseSync(fixture.databaseFile);
  try {
    db.exec(`INSERT INTO catalog_fields VALUES
      ('Upgrade','Stimpack','EffectArray[0].@Reference','Unit,HyperionVoidCoop,LifeMax','EffectArray','Reference','test.xml','Stimpack',0),
      ('Upgrade','Stimpack','EffectArray[0].@Value','40','EffectArray','Value','test.xml','Stimpack',0),
      ('Upgrade','Stimpack','EffectArray[0].@Operation','Add','EffectArray','Operation','test.xml','Stimpack',0);
      INSERT INTO object_references VALUES('Upgrade','Stimpack','EffectArray[0].@Reference','Unit','HyperionVoidCoop',1,'test');`);
    buildCoopSemantics(db);
  } finally {db.close();}
  const search=createCoopSearch(fixture),get=q=>executeScalarSearch(search,{operation:'entity.get',catalog:'Unit',objectId:'HyperionVoidCoop',commanderId:'TerranRaynor',...q});
  const card=get({}).objectCard;
  assert.equal(card.entries.find(e=>e.path==='LifeMax').influenceSummary.total,1);
  assert.equal(card.valueContext.runtimeEvaluated,false);
  const exact=get({path:'LifeMax'});assert.equal(exact.fieldInfluences.entries[0].operand,'40');
  assert.equal(exact.fieldInfluences.runtimeValue,null);assert.equal(exact.editState.runtimeValue.known,false);
  const next=card.entries.find(e=>e.path==='LifeMax').influenceSummary.nextQuery;
  const details=executeScalarSearch(search,next);assert.equal(details.responseMode,'field-influences');assert.equal(details.fieldInfluences.total,1);
  assert.equal(details.fieldInfluences.entries[0].reference.objectId,'Stimpack');
  assert.equal(get({fieldPrefix:'Life'}).fields.find(e=>e.path==='LifeMax').influenceSummary.total,1);
  assert.equal(get({topic:'fields'}).objectCard.entries.find(e=>e.path==='LifeMax').influenceSummary.total,1);
  assert.throws(()=>get({topic:'influences',path:'LifeMax',include:['fields']}),/do not combine/);
});

test('ordinary exact field reads expose script input/output usage without a mastery topic', async () => {
  const fixture=await createFixture();reindexGalaxySymbols(fixture.databaseFile);
  const search=createCoopSearch({...fixture,reuseSnapshots:true});
  const read=(objectId)=>executeScalarSearch(search,{operation:'entity.get',catalog:'Effect',objectId,path:'Amount'});
  const fenix=read('AvengingProtocolAttackSpeedDummy');
  assert.equal(fenix.responseMode,'exact-field');
  assert.deepEqual(fenix.usageEvidence.uses,['script-input']);
  assert.equal(fenix.usageEvidence.readers[0].function,'ReadFenix');
  assert.equal(fenix.usageEvidence.readers[0].sourceFile,'starcoop.sc2mod:base.sc2data/fieldusage.galaxy');
  assert.equal(fenix.usageEvidence.sourceQueries[0].operation,'galaxy.context');
  const source=executeScalarSearch(search,fenix.usageEvidence.sourceQueries[0]);
  assert.equal(source.operation,'galaxy.context');
  assert.ok(source.definitions?.length,JSON.stringify(source));
  assert.equal(source.definitions[0].sourceSha256,'field-usage-sha');
  assert.match(source.definitions[0].body.text,/CatalogFieldValueGetAsReal/);
  assert.equal(source.definitions[0].body.complete,true);
  const voidShard=read('VoidShardACDeathGripDamageDummy');
  assert.deepEqual(voidShard.usageEvidence.uses,['script-output']);
  assert.equal(voidShard.usageEvidence.writers[0].function,'WriteVoidShard');
  assert.equal(voidShard.usageEvidence.coverage.gameASource,'not-indexed');
});

test('ordinary and upgrade views reuse the same target usage evidence', async () => {
  const fixture=await createFixture(),search=createCoopSearch({...fixture,reuseSnapshots:true});
  const ordinary=executeScalarSearch(search,{operation:'entity.get',catalog:'Effect',objectId:'AvengingProtocolAttackSpeedDummy',path:'Amount'});
  const upgrade=executeScalarSearch(search,{operation:'entity.get',catalog:'Upgrade',objectId:'FenixUsageUpgrade',topic:'upgradeEffects'});
  assert.equal(upgrade.upgradeEffects.effects.length,1);
  assert.deepEqual(upgrade.upgradeEffects.effects[0].targetUsageEvidence,ordinary.usageEvidence);
  assert.deepEqual(upgrade.upgradeEffects.effects[0].operandUsageEvidence.uses,['unidentified']);
});

test('generic field guide is ID-based, paginated, typed and separate from exact/current reads',async()=>{
  const fixture=await createFixture(),db=new DatabaseSync(fixture.databaseFile);
  try { buildCoopSemantics(db); } finally { db.close(); }
  const search=createCoopSearch(fixture),get=q=>executeScalarSearch(search,{operation:'entity.get',...q});
  const root={catalog:'Unit',objectId:'HyperionVoidCoop',commanderId:'TerranRaynor'};
  const parameters=get(root).objectCard;
  assert.equal(parameters.writeEligibility,'not-checked');assert.ok(parameters.entries.some(e=>e.path==='LifeMax'));
  const parameterPage=get({...root,topic:'parameters',limit:1});
  assert.equal(parameterPage.responseMode,'object-card');assert.equal(parameterPage.officialFacts,undefined);
  assert.equal(parameterPage.fields,undefined);assert.equal(parameterPage.objectCard.entries.length,1);
  assert.equal(get({...root,path:'LifeMax'}).objectCard,undefined);
  assert.equal(get({...root,fieldPrefix:'Life'}).objectCard,undefined);
  assert.throws(()=>get({...root,topic:'parameters',path:'LifeMax'}),/do not combine/);
  assert.equal(parameters.fieldsQuery.topic,'fields');
  let page=get({...parameters.fieldsQuery,limit:2}),entries=[];
  assert.equal(page.responseMode,'object-card');assert.equal(page.objectCard.mode,'fields');assert.equal(page.fields,undefined);assert.equal(page.officialFacts,undefined);
  for(;;){entries.push(...page.objectCard.entries);if(!page.objectCard.nextQuery)break;page=get(page.objectCard.nextQuery);}
  assert.equal(entries.length,page.objectCard.total);
  const life=entries.find(e=>e.path==='LifeMax');assert.equal(life.meaning.label,'生命上限');
  const exact=get({...life.nextQuery,include:['effectiveField']});assert.equal(exact.fieldMeaning.label,'生命上限');assert.equal(exact.fieldGuide,undefined);
  assert.equal(exact.responseMode,'exact-field');assert.equal(exact.effectiveField.field.value,2000);
  const fields=get({...root,fieldPrefix:'Life'});assert.equal(fields.fields[0].meaning.status,'documented');
  const upgrade=get({catalog:'Upgrade',objectId:'Stimpack',topic:'fields'});
  assert.equal(upgrade.objectCard.entity.catalog,'Upgrade','field guide does not require a commander or prebuilt dossier');
  assert.deepEqual(get({...root,topic:'fields',detailLevel:'full'}).objectCard,get({...root,topic:'fields'}).objectCard);
  assert.throws(()=>get({...root,topic:'parameters',maxDepth:2}),/do not combine/);
  assert.throws(()=>get({...root,topic:'fields',path:'LifeMax'}),/do not combine/);
  assert.throws(()=>get({catalog:'Abil',objectId:'CommandCenterTrain',topic:'fields',commandIndex:'UnknownSlot'}),/Unknown.*commandIndex/);
});

test('prestige display aliases navigate to actual Upgrade and only the actual ID is a valid scope',async()=>{
  const fixture=await createFixture(),db=new DatabaseSync(fixture.databaseFile);
  try {
    const put=db.prepare('INSERT INTO catalog_objects VALUES (?,?,?,NULL,0,?,?)');
    put.run('User','PlayerCommanders','CUser','synthetic.xml',
      '<CUser><Instances Id="TerranRaynor"><User Type="PlayerPrestige" Instance="SyntheticPrestige"><Field Id="Prestige"/></User></Instances></CUser>');
    put.run('User','PlayerPrestige','CUser','synthetic.xml',
      '<CUser><Instances Id="SyntheticPrestige"><GameLink GameLink="Stimpack"><Field Id="PrimaryUpgrade"/></GameLink></Instances></CUser>');
    put.run('Button','SyntheticPrestigeFace','CButton','synthetic.xml','<CButton/>');
    const p=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('TerranRaynor').profile_json);
    p.prestiges=[{id:'SyntheticPrestigeFace',index:0}];
    db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(p),'TerranRaynor');
    buildCoopSemantics(db);
  } finally {db.close();}
  const search=createCoopSearch(fixture);
  const c=executeScalarSearch(search,{operation:'commander.get',commanderId:'TerranRaynor',topic:'prestiges'});
  assert.equal(c.officialFacts.entries[0].id,'SyntheticPrestigeFace');assert.equal(c.officialFacts.entries[0].primaryUpgrade,'Stimpack');
  assert.equal(c.officialFacts.entries[0].targets[0].objectId,'Stimpack');
  assert.equal(c.roster,undefined);assert.equal(c.levelPerks,undefined);
  const q={operation:'entity.get',commanderId:'TerranRaynor',catalog:'Unit',objectId:'HyperionVoidCoop',path:'LifeMax',prestigeUpgrade:'Stimpack'};
  const r=executeScalarSearch(search,q);assert.equal(r.currentProject.prestigeUpgrade,'Stimpack');
  assert.throws(()=>executeScalarSearch(search,{...q,prestigeUpgrade:'SyntheticPrestigeFace'}),/prestigeUpgrade/);
  const plan={operations:[{opId:'test',kind:'commander.stat.set',commanderId:'TerranRaynor',prestigeUpgrade:'Stimpack'}]};
  assert.doesNotThrow(()=>validatePrestigeContract(plan,{databaseFile:fixture.databaseFile,request:'P1 修改生命'}));
  assert.throws(()=>validatePrestigeContract({operations:[{...plan.operations[0],prestigeUpgrade:'SyntheticPrestigeFace'}]},
    {databaseFile:fixture.databaseFile,request:'P1 修改生命'}),/not a known prestige/);
});

test('entity.get attaches prebuilt facts by the exact resolved ID without a separate semantic search', async () => {
  const fixture = await createFixture();
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    db.exec("INSERT INTO catalog_objects VALUES ('Commander','Raynor','CCommander',NULL,0,'synthetic.xml','<CCommander/>')");
    const p=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('TerranRaynor').profile_json);
    p.prestiges=[{id:'Stimpack',index:0}];
    db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(p),'TerranRaynor');
    buildCoopSemantics(db);
  } finally { db.close(); }
  const search = createCoopSearch(fixture);
  const input = {operation:'entity.get',commanderId:'TerranRaynor',catalog:'Unit',objectId:'HyperionVoidCoop'};
  const r = executeScalarSearch(search,input);
  assert.equal(r.entity.objectId,'HyperionVoidCoop');
  assert.equal(r.objectCard.entity.objectId,r.entity.objectId);
  assert.equal(r.objectCard.entries.find(a=>a.path==='LifeMax').baselineValue,'2000');
  assert.equal(r.objectCard.currentProjectIncluded,false);
  for(const key of ['officialFacts','fieldGuide','parameterGuide'])assert.equal(r[key],undefined);
  assert.equal(r.fields,undefined,'MCP directory omits unrelated raw fields');
  assert.equal(r.responseMode,'object-card');
  const topic = executeScalarSearch(search,{...input,topic:'abilities',limit:1});
  assert.equal(topic.officialFacts.topic,'abilities');
  assert.equal(topic.fields,undefined,'topic returns facts, not an unrelated field page');
  assert.equal(executeScalarSearch(search,{...input,path:'LifeMax'}).officialFacts,undefined);
  assert.equal(executeScalarSearch(search,{...input,fieldPrefix:'Life'}).officialFacts,undefined);
  assert.equal(executeScalarSearch(search,{...input,include:['fields']}).officialFacts,undefined);
  assert.equal(executeScalarSearch(search,{...input,catalog:'Abil',objectId:'CommandCenterTrain'}).responseMode,'object-card','child nodes use the same card');
  const commander=executeScalarSearch(search,{operation:'commander.get',commanderId:'TerranRaynor'});
  assert.equal(commander.officialFacts.kind,'commander-directory');
  const section=commander.officialFacts.sections.find(s=>s.section==='prestiges');
  assert.equal(section.total,1);
  const page=executeScalarSearch(search,section.nextQuery);
  assert.equal(page.responseMode,'commander-directory');
  assert.equal(page.fields,undefined);
  const entry=page.officialFacts.entries[0];
  assert.equal(entry.coverage.runtimeEvaluated,false);
  assert.equal(executeScalarSearch(search,entry.targets[0].nextQuery).responseMode,'object-card');
  const recovered=executeScalarSearch(search,{operation:'entity.get',commanderId:'TerranRaynor',objectId:'Stimpack'});
  assert.equal(recovered.officialFacts.entries[0].coverage.status,'partial');
  const scopedEntry=executeScalarSearch(search,{operation:'entity.get',commanderId:'TerranRaynor',objectId:'Stimpack',prestigeUpgrade:'Stimpack'});
  assert.equal(scopedEntry.officialFacts.entries[0].targets[0].nextQuery.prestigeUpgrade,'Stimpack');
  assert.throws(()=>search.execute({...input,query:'Hyperion'}),/entity.resolve/);
  assert.throws(()=>search.execute({...input,objectId:undefined,query:'Hyperion'}),/objectId/);
  assert.throws(()=>search.execute({...input,operation:'semantic.get'}),/Unknown search operation/);
  assert.throws(()=>search.execute({...input,topic:'production',path:'LifeMax'}),/do not combine/);
  const scoped=executeScalarSearch(search,{...input,prestigeUpgrade:'Stimpack'});
  assert.equal(scoped.objectCard.entries[0].nextQuery.prestigeUpgrade,'Stimpack');
  assert.equal(scoped.objectCard.currentProjectIncluded,false);
});

test('old and non-indexed entities still use normal ID-based reads', async () => {
  const fixture=await createFixture(), search=createCoopSearch(fixture);
  const input={operation:'entity.get',commanderId:'TerranRaynor',catalog:'Unit',objectId:'HyperionVoidCoop'};
  const old=search.execute(input);
  assert.equal(old.officialFacts.status,'missing');
  assert.equal(old.entity.objectId,input.objectId);
  for(const topic of ['parameters','fields']) {
    const missing=executeScalarSearch(search,{...input,topic});
    assert.equal(missing.objectCard.status,'missing');assert.equal(missing.objectCard.entries,undefined);
    assert.ok(executeScalarSearch(search,missing.objectCard.fallbackQuery).fields.length);
  }
  const db=new DatabaseSync(fixture.databaseFile);
  try { buildCoopSemantics(db); } finally { db.close(); }
  const unknown=search.execute({...input,objectId:'Marine'});
  assert.equal(unknown.entity.objectId,'Marine');
  assert.equal(unknown.officialFacts.status,'not-indexed');
  assert.ok(unknown.fields.length);
});

test('commander topic filtering is real and group options cannot be silently ignored',async()=>{
  const fixture=await createFixture(),db=new DatabaseSync(fixture.databaseFile);
  try{buildCoopSemantics(db);}finally{db.close();}
  const search=createCoopSearch(fixture),get=q=>executeScalarSearch(search,q);
  const q={operation:'commander.get',commanderId:'TerranRaynor',topic:'units',limit:1};
  const r=get(q);assert.equal(r.officialFacts.topic,'units');assert.equal(r.officialFacts.entries.length,1);
  for(const key of ['roster','levelPerks','prestiges','masteries','panel'])assert.equal(r[key],undefined,key);
  if(r.officialFacts.nextQuery){const next=get(r.officialFacts.nextQuery);assert.equal(next.officialFacts.offset,1);}
  assert.throws(()=>get({...q,topic:'abilities'}),/Unknown.*topic/);
  assert.throws(()=>get({...q,include:['fields']}),/do not apply/);
  const root={operation:'entity.get',commanderId:'TerranRaynor',catalog:'Unit',objectId:'HyperionVoidCoop'};
  const card=get(root).objectCard;assert.ok(card.identity.evidence.length);
  const attributes=get({...root,group:'attributes'}).objectCard;
  assert.ok(attributes.entries.every(e=>e.section==='onThisObject'));
  for(const extra of [{path:'LifeMax'},{topic:'fields'},{include:['fields']},{maxDepth:1}])assert.throws(()=>get({...root,group:'attributes',...extra}),/does not combine/);
});

test('an exact unrelated ID match does not suppress selected commander localized-name recall',async()=>{
  const fixture=await createFixture(),db=new DatabaseSync(fixture.databaseFile);
  try{
    db.exec("INSERT INTO catalog_fields VALUES ('Unit','HyperionVoidCoop','Name','Unit/Name/HyperionVoidCoop','Name','value','synthetic.xml','HyperionVoidCoop',0)");
    db.exec("INSERT INTO localized_text VALUES ('zhCN','Unit/Name/HyperionVoidCoop','Marine','synthetic.txt')");
  }finally{db.close();}
  const result=executeScalarSearch(createCoopSearch(fixture),{operation:'entity.resolve',commanderId:'TerranRaynor',catalog:'Unit',query:'Marine'});
  const found=result.candidates.find(c=>c.objectId==='HyperionVoidCoop');assert.ok(found);
  assert.equal(found.nextQuery.commanderId,'TerranRaynor');assert.equal(found.nextQuery.catalog,'Unit');
});

test('commander entries hand typed effects to entity.get without guessing names or Catalogs', async () => {
  const fixture = await createFixture();
  const db = new DatabaseSync(fixture.databaseFile);
  const row = db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('TerranRaynor');
  const profile = JSON.parse(row.profile_json);
  profile.levelPerks = [{ id: 'DisplayLevel10', level: 10, levelId: 'RaynorLevel10', links: [
    { catalog: 'Button', objectId: 'Stimpack', fieldId: 'Button' },
    { catalog: 'Upgrade', objectId: 'Stimpack', fieldId: 'Upgrade' },
    { catalog: 'Abil', objectId: 'BarracksResearch', commandIndex: 0, fieldId: 'AbilityCommand' },
    { catalog: 'Abil', objectId: 'BarracksResearch', commandIndex: 1, fieldId: 'AbilityCommand' },
    { catalog: 'Abil', objectId: 'ObsoleteResearch', commandIndex: 2, fieldId: 'AbilityCommand' },
  ] }, { id: 'NoKnownEffect', level: 1, links: [{ catalog: 'Button', objectId: 'Stimpack' }] }];
  profile.masteries = [{ id: 'RaynorMastery1', category: 1, links: [{ catalog: 'Upgrade', objectId: 'Stimpack', fieldId: 'Upgrade' }] }];
  profile.prestiges = [{ id: 'Stimpack', index: 0 }];
  db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(profile), 'TerranRaynor');
  db.close();
  const search = createCoopSearch(fixture);
  const get = input => executeScalarSearch(search, input);
  const commander = get({ operation: 'commander.get', commanderId: 'TerranRaynor', detailLevel:'full' });
  const perk = commander.levelPerks[0];
  assert.deepEqual(perk.presentation, { catalog: 'Button', objectId: 'Stimpack' });
  assert.equal(perk.navigation.status, 'partial');
  assert.equal(perk.navigation.unresolvedTargets[0].objectId, 'ObsoleteResearch');
  assert.deepEqual(perk.effectTargets.map(t => [t.catalog, t.objectId, t.commandIndex]), [
    ['Upgrade', 'Stimpack', undefined], ['Abil', 'BarracksResearch', 0], ['Abil', 'BarracksResearch', 1],
  ]);
  for (const item of [perk, commander.masteries[0], commander.prestiges[0]]) {
    const recovered = get({ operation: 'entity.get', commanderId: 'TerranRaynor', objectId: item.id });
    assert.equal(recovered.responseMode, 'commander-entry');
    assert.equal(recovered.entity, null);
    assert.equal(recovered.editState, undefined);
    assert.deepEqual(recovered.commanderEntries[0].effectTargets, item.effectTargets);
    for (const target of item.effectTargets) {
      const result = get({ operation: 'entity.get', commanderId: 'TerranRaynor', catalog: target.catalog, objectId: target.objectId });
      assert.equal(result.entity.objectId, target.objectId);
    }
  }
  assert.equal(commander.levelPerks[1].navigation.status, 'unresolved');
  assert.deepEqual(commander.levelPerks[1].effectTargets, []);
  // The display object is still a Button; navigation never masquerades as its fields.
  const display = get({ operation: 'entity.get', commanderId: 'TerranRaynor', ...perk.presentation });
  assert.equal(display.entity.catalog, 'Button');
  assert.equal(display.commanderEntries[0].effectTargets[0].catalog, 'Upgrade');
  assert.throws(() => get({ operation: 'entity.get', commanderId: 'TerranRaynor', catalog: 'Upgrade', objectId: perk.id }),
    e => e.details.commanderEntries[0].effectTargets[0].objectId === 'Stimpack');
  assert.throws(() => get({ operation: 'entity.get', objectId: 'Stimpack' }), e => e.details.candidates.length === 2);
  const exact = get({ operation: 'entity.get', commanderId: 'TerranRaynor', objectId: 'HyperionVoidCoop', path: 'LifeMax' });
  assert.equal(exact.entity.catalog, 'Unit');
  assert.equal(exact.commanderEntries, undefined);
  assert.throws(() => get({ operation: 'entity.get', commanderId: 'ProtossArtanis', objectId: 'DisplayLevel10' }), /Unknown/);
});

test("commander reads tolerate a short database lock without changing data", { timeout: 10000 }, async (t) => {
  const fixture = await createFixture();
  const before = await readFile(fixture.databaseFile);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(fixture.databaseFile)});
    db.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready');
    setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 400);
  `], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  const result = createCoopSearch(fixture).execute({ operation: "commander.list" });
  assert.ok(result.items.some((item) => item.id === "TerranRaynor"));
  assert.equal((await closed)[0], 0);
  assert.deepEqual(await readFile(fixture.databaseFile), before);
});

test("persistent database locks fail with bounded, actionable evidence", { timeout: 10000 }, async (t) => {
  const fixture = await createFixture();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(fixture.databaseFile)});
    db.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready');
    process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.stdin.destroy(); });
  `], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, "data");
  try {
    const started = Date.now();
    assert.throws(() => createCoopSearch(fixture).execute({ operation: "commander.list" }),
      (error) => error instanceof CoopSearchError && error.details.code === "database-busy"
        && error.details.databaseFile === fixture.databaseFile && error.details.waitMs === 2000);
    assert.ok(Date.now() - started >= 1800, "must allow a transient lock to clear");
  } finally { child.stdin.end("release"); }
  assert.equal((await closed)[0], 0);
  assert.ok(createCoopSearch(fixture).execute({ operation: "commander.list" }).items.length > 0);
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "coop-search-"));
  const repoRoot = path.join(root, "repo");
  const databaseFile = path.join(root, "coop.sqlite");
  const commanderAliasesFile = path.join(root, "commander-aliases.json");
  await mkdir(path.join(repoRoot, "game-a", "patches"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "game-a", "runtime-baseline.json"),
    JSON.stringify({ sc2: { dataBuild: "BTEST" } }),
    "utf8",
  );
  await writeFile(
    commanderAliasesFile,
    JSON.stringify({
      schemaVersion: 1,
      commanders: { TerranRaynor: { aliases: ["游骑兵长", "游骑兵长"] } },
    }),
    "utf8",
  );
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES
      ('schemaVersion','1'), ('sc2Build','BTEST'), ('sc2Version','test');
    CREATE TABLE catalog_objects(
      catalog TEXT, object_id TEXT, class TEXT, parent_id TEXT, is_default INTEGER,
      source_file TEXT, direct_xml TEXT
    );
    CREATE TABLE catalog_fields(
      catalog TEXT, object_id TEXT, path TEXT, value TEXT, field_tag TEXT,
      attribute TEXT, source_file TEXT, origin_object_id TEXT, inheritance_depth INTEGER
    );
    CREATE TABLE object_references(
      source_catalog TEXT, source_object_id TEXT, field_path TEXT,
      target_catalog TEXT, target_object_id TEXT, confidence REAL, evidence TEXT
    );
    CREATE TABLE localized_text(locale TEXT, text_key TEXT, value TEXT, source_file TEXT);
    CREATE TABLE galaxy_files(
      source_file TEXT PRIMARY KEY, package_id TEXT, sha256 TEXT, contents TEXT
    );
    CREATE TABLE galaxy_symbols(source_file TEXT, name TEXT, kind TEXT, line INTEGER);
    CREATE TABLE commanders(
      id TEXT, commander_object_id TEXT, user_reference TEXT, name_key TEXT,
      name_zhcn TEXT, name_enus TEXT
    );
    CREATE TABLE commander_profiles(commander_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL);
    CREATE TABLE commander_membership(
      commander_id TEXT, catalog TEXT, object_id TEXT, evidence TEXT, depth INTEGER
    );
    CREATE VIRTUAL TABLE search_index USING fts5(kind, key, title, body);

    INSERT INTO catalog_objects VALUES
      ('Unit','HyperionVoidCoop','CUnit',NULL,0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Unit','PhotonCannon','CUnit',NULL,0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Abil','VoidCoopSummonHyperion','CAbilEffectInstant',NULL,0,'starcoop:abildata.xml','<CAbilEffectInstant/>'),
      ('Unit','SCV','CUnit',NULL,0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Unit','CommandCenter','CUnit',NULL,0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Abil','CommandCenterTrain','CAbilTrain',NULL,0,'starcoop:abildata.xml','<CAbilTrain id="CommandCenterTrain"><InfoArray index="Train1"><Unit value="SCV"/></InfoArray></CAbilTrain>'),
      ('Unit','Marine','CUnit',NULL,0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Unit','EnemyMarine','CUnit','Marine',0,'starcoop:unitdata.xml','<CUnit/>'),
      ('Weapon','GaussRifle','CWeapon',NULL,0,'starcoop:weapondata.xml','<CWeapon/>'),
      ('Effect','GaussSet','CEffectSet',NULL,0,'starcoop:effectdata.xml','<CEffectSet/>'),
      ('Effect','GaussDamage','CEffectDamage',NULL,0,'starcoop:effectdata.xml','<CEffectDamage/>'),
      ('Behavior','StimpackBuff','CBehaviorBuff',NULL,0,'starcoop:behaviordata.xml','<CBehaviorBuff/>'),
      ('Abil','BarracksResearch','CAbilResearch',NULL,0,'starcoop:abildata.xml','<CAbilResearch/>'),
      ('Upgrade','Stimpack','CUpgrade',NULL,0,'starcoop:upgradedata.xml','<CUpgrade/>'),
      ('Button','Stimpack','CButton',NULL,0,'starcoop:buttondata.xml','<CButton/>'),
      ('Requirement','LearnStimpack','CRequirement',NULL,0,'starcoop:requirementdata.xml','<CRequirement/>'),
      ('Requirement','AndAllowMarineNotStim','CRequirementAnd',NULL,0,'starcoop:requirementdata.xml','<CRequirementAnd/>'),
      ('Requirement','AllowUnitMarine','CRequirementAllowUnit',NULL,0,'starcoop:requirementdata.xml','<CRequirementAllowUnit/>'),
      ('Requirement','NotCountStimpack','CRequirementNot',NULL,0,'starcoop:requirementdata.xml','<CRequirementNot/>'),
      ('Requirement','CountUpgradeStimpack','CRequirementCountUpgrade',NULL,0,'starcoop:requirementdata.xml','<CRequirementCountUpgrade/>');
    INSERT INTO catalog_fields VALUES
      ('Unit','HyperionVoidCoop','LifeMax','2000','LifeMax','value','starcoop:unitdata.xml','HyperionVoidCoop',0),
      ('Abil','CommandCenterTrain','InfoArray[Train1].@Time','17','InfoArray','Time','starcoop:abildata.xml','CommandCenterTrain',0),
      ('Abil','CommandCenterTrain','InfoArray[Train1].Button.@DefaultButtonFace','SCV','Button','DefaultButtonFace','starcoop:abildata.xml','CommandCenterTrain',0),
      ('Abil','CommandCenterTrain','InfoArray[Train1].Unit','SCV','Unit',NULL,'starcoop:abildata.xml','CommandCenterTrain',0),
      ('Unit','Marine','Name','Unit/Name/Marine','Name','value','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','LifeMax','55','LifeMax','value','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','Radius','0.5','Radius','value','core:unitdata.xml','@default:CUnit',1),
      ('Unit','Marine','AbilArray[#0].@Link','move','AbilArray','Link','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','AbilArray[#1].@Link','attack','AbilArray','Link','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[#0].LayoutButtons[#0].@Type','AbilCmd','LayoutButtons','Type','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[#0].LayoutButtons[#0].@AbilCmd','move,Move','LayoutButtons','AbilCmd','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[#0].LayoutButtons[#0].@Face','Move','LayoutButtons','Face','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[0].LayoutButtons[#0].@Type','AbilCmd','LayoutButtons','Type','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[0].LayoutButtons[#0].@AbilCmd','Stimpack,Execute','LayoutButtons','AbilCmd','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[0].LayoutButtons[#0].@Face','Stimpack','LayoutButtons','Face','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[0].LayoutButtons[0].@Requirements','HaveMove','LayoutButtons','Requirements','starcoop:unitdata.xml','Marine',0),
      ('Unit','Marine','CardLayouts[#0].@CardId','CommandCard','CardLayouts','CardId','starcoop:unitdata.xml','Marine',0),
      ('Upgrade','Stimpack','Name','Upgrade/Name/Stimpack','Name','value','starcoop:upgradedata.xml','Stimpack',0),
      ('Button','Stimpack','Name','Button/Name/Stimpack','Name','value','starcoop:buttondata.xml','Stimpack',0),
      ('Requirement','LearnStimpack','NodeArray[Show].@Link','AndAllowMarineNotStim','NodeArray','Link','starcoop:requirementdata.xml','LearnStimpack',0),
      ('Requirement','AndAllowMarineNotStim','OperandArray[#0]','AllowUnitMarine','OperandArray','value','starcoop:requirementdata.xml','AndAllowMarineNotStim',0),
      ('Requirement','AndAllowMarineNotStim','OperandArray[#1]','NotCountStimpack','OperandArray','value','starcoop:requirementdata.xml','AndAllowMarineNotStim',0),
      ('Requirement','AllowUnitMarine','Link','Marine','Link','value','starcoop:requirementdata.xml','AllowUnitMarine',0),
      ('Requirement','NotCountStimpack','OperandArray[#0]','CountUpgradeStimpack','OperandArray','value','starcoop:requirementdata.xml','NotCountStimpack',0),
      ('Requirement','CountUpgradeStimpack','Count.@Link','Stimpack','Count','Link','starcoop:requirementdata.xml','CountUpgradeStimpack',0),
      ('Requirement','CountUpgradeStimpack','Count.@State','QueuedOrBetter','Count','State','starcoop:requirementdata.xml','CountUpgradeStimpack',0);
    INSERT INTO object_references VALUES
      ('Abil','VoidCoopSummonHyperion','Effect[0]','Unit','HyperionVoidCoop',1.0,'fixture'),
      ('Abil','CommandCenterTrain','InfoArray[Train1].Unit','Unit','SCV',1.0,'field-hint:Unit'),
      ('Unit','CommandCenter','AbilArray[#2].@Link','Abil','CommandCenterTrain',1.0,'field-hint:Abil'),
      ('Unit','CommandCenter','TechTreeProducedUnitArray[#0]','Unit','SCV',1.0,'field-hint:Unit'),
      ('Unit','Marine','WeaponArray[0].Link','Weapon','GaussRifle',1.0,'field-hint:Weapon'),
      ('Unit','EnemyMarine','WeaponArray[0].Link','Weapon','GaussRifle',1.0,'field-hint:Weapon'),
      ('Weapon','GaussRifle','Effect','Effect','GaussSet',1.0,'field-hint:Effect'),
      ('Effect','GaussSet','EffectArray[#0]','Effect','GaussDamage',1.0,'field-hint:Effect'),
      ('Effect','GaussDamage','Behavior','Behavior','StimpackBuff',1.0,'field-hint:Behavior'),
      ('Behavior','StimpackBuff','PeriodicEffect','Effect','GaussSet',1.0,'field-hint:Effect'),
      ('Abil','BarracksResearch','InfoArray[Research1].Upgrade','Upgrade','Stimpack',1.0,'field-hint:Upgrade'),
      ('Requirement','CountUpgradeStimpack','Count.@Link','Upgrade','Stimpack',1.0,'field-hint:Upgrade'),
      ('Upgrade','Stimpack','EffectArray[#0].Reference','Unit','Marine',1.0,'field-hint:Unit');
    INSERT INTO localized_text VALUES
      ('zhCN','Unit/Name/Marine','陆战队员 /// Marine','starcoop:gamestrings.txt'),
      ('enUS','Unit/Name/Marine','Marine','starcoop:gamestrings.txt'),
      ('zhCN','Upgrade/Name/Stimpack','强化剂 /// Stimpack','starcoop:gamestrings.txt'),
      ('enUS','Upgrade/Name/Stimpack','Stimpack','starcoop:gamestrings.txt'),
      ('zhCN','Button/Name/Stimpack','强化剂按钮 /// Stimpack','starcoop:gamestrings.txt'),
      ('enUS','Button/Name/Stimpack','Stimpack','starcoop:gamestrings.txt');
    INSERT INTO commanders VALUES
      ('TerranRaynor','Raynor','PlayerCommanders;TerranRaynor','Raynor_Name','雷诺','Raynor'),
      ('ProtossArtanis','Artanis','PlayerCommanders;ProtossArtanis','Artanis_Name','阿塔尼斯','Artanis'),
      ('ProtossKarax','Karax','PlayerCommanders;ProtossKarax','Karax_Name','凯拉克斯','Karax');
    INSERT INTO commander_membership VALUES
      ('TerranRaynor','Unit','HyperionVoidCoop','typed-userdata:HeroUnit',0),
      ('ProtossArtanis','Unit','PhotonCannon','typed-userdata:Commander.UnitArray',0),
      ('ProtossKarax','Unit','PhotonCannon','typed-userdata:Commander.UnitArray',0),
      ('ProtossKarax','Unit','HyperionVoidCoop','reference-depth:1',1),
      ('TerranRaynor','Unit','SCV','reference-depth:1',1),
      ('TerranRaynor','Unit','CommandCenter','typed-userdata:TechUnit',0),
      ('TerranRaynor','Unit','Marine','typed-userdata:Commander.UnitArray',0),
      ('TerranRaynor','Upgrade','Stimpack','reference-depth:1',1),
      ('TerranRaynor','Abil','CommandCenterTrain','reference-depth:1',1),
      ('TerranRaynor','Abil','BarracksResearch','reference-depth:1',1),
      ('TerranRaynor','Behavior','StimpackBuff','reference-depth:2',2);
    INSERT INTO search_index VALUES
      ('catalog','Unit/HyperionVoidCoop','HyperionVoidCoop','CUnit Hyperion Raynor'),
      ('catalog','Unit/Marine','Marine','CUnit Marine Unit/Name/Marine'),
      ('catalog','Upgrade/Stimpack','Stimpack','CUpgrade Stimpack Upgrade/Name/Stimpack'),
      ('catalog','Button/Stimpack','Stimpack','CButton Stimpack Button/Name/Stimpack');
  `);
  const insertGalaxyFile = database.prepare(
    "INSERT INTO galaxy_files(source_file, package_id, sha256, contents) VALUES (?, ?, ?, ?)",
  );
  insertGalaxyFile.run(
    "starcoop.sc2mod:base.sc2data/libcoui_h.galaxy",
    "starcoop.sc2mod",
    "header-sha",
    "// Hero panel API\nvoid libCOUI_gf_SetHeroPanelUnit (int slot, unit hero, int player);\n",
  );
  insertGalaxyFile.run(
    "starcoop.sc2mod:base.sc2data/libcoui.galaxy",
    "starcoop.sc2mod",
    "implementation-sha",
    "// Hero panel implementation\nvoid libCOUI_gf_SetHeroPanelUnit (int slot, unit hero, int player) {\n    UnitSetState(hero, c_unitStateTooltipable, true);\n}\n",
  );
  insertGalaxyFile.run(
    "starcoop.sc2mod:base.sc2data/coophero.galaxy",
    "starcoop.sc2mod",
    "caller-sha",
    "void CoopHeroInit () {\n    unit hero;\n    UnitCreate(1, \"HyperionVoidCoop\", c_unitCreateIgnorePlacement, 1, null, 0.0);\n    hero = UnitLastCreated();\n    libCOUI_gf_SetHeroPanelUnit(1, hero, 1);\n}\n",
  );
  database.exec(`
    INSERT INTO catalog_objects VALUES
      ('Effect','AvengingProtocolAttackSpeedDummy','CEffectDamage',NULL,0,'starcoop:effectdata.xml','<CEffectDamage id="AvengingProtocolAttackSpeedDummy"><Amount value="0.1"/></CEffectDamage>'),
      ('Effect','VoidShardACDeathGripDamageDummy','CEffectDamage',NULL,0,'starcoop:effectdata.xml','<CEffectDamage id="VoidShardACDeathGripDamageDummy"><Amount value="0"/></CEffectDamage>'),
      ('Upgrade','FenixUsageUpgrade','CUpgrade',NULL,0,'starcoop:upgradedata.xml','<CUpgrade id="FenixUsageUpgrade"/>');
    INSERT INTO catalog_fields VALUES
      ('Effect','AvengingProtocolAttackSpeedDummy','Amount','0.1','Amount','value','starcoop:effectdata.xml','AvengingProtocolAttackSpeedDummy',0),
      ('Effect','VoidShardACDeathGripDamageDummy','Amount','0','Amount','value','starcoop:effectdata.xml','VoidShardACDeathGripDamageDummy',0),
      ('Upgrade','FenixUsageUpgrade','EffectArray[0].@Reference','Effect,AvengingProtocolAttackSpeedDummy,Amount','EffectArray','Reference','starcoop:upgradedata.xml','FenixUsageUpgrade',0),
      ('Upgrade','FenixUsageUpgrade','EffectArray[0].@Value','0.1','EffectArray','Value','starcoop:upgradedata.xml','FenixUsageUpgrade',0);
    INSERT INTO object_references VALUES
      ('Upgrade','FenixUsageUpgrade','EffectArray[0].@Reference','Effect','AvengingProtocolAttackSpeedDummy',1,'test');
  `);
  insertGalaxyFile.run(
    "starcoop.sc2mod:base.sc2data/fieldusage.galaxy",
    "starcoop.sc2mod",
    "field-usage-sha",
    `void ReadFenix () { fixed haste = CatalogFieldValueGetAsReal(c_gameCatalogEffect, "AvengingProtocolAttackSpeedDummy", "Amount", 1); }
bool WriteVoidShard () { CatalogFieldValueSet(c_gameCatalogEffect, "VoidShardACDeathGripDamageDummy", "Amount", 1, "75"); return true; }
`,
  );
  const insertGalaxySymbol = database.prepare(
    "INSERT INTO galaxy_symbols(source_file, name, kind, line) VALUES (?, ?, ?, ?)",
  );
  insertGalaxySymbol.run(
    "starcoop.sc2mod:base.sc2data/libcoui_h.galaxy",
    "libCOUI_gf_SetHeroPanelUnit",
    "function",
    1,
  );
  insertGalaxySymbol.run(
    "starcoop.sc2mod:base.sc2data/libcoui.galaxy",
    "libCOUI_gf_SetHeroPanelUnit",
    "function",
    1,
  );
  insertGalaxySymbol.run(
    "starcoop.sc2mod:base.sc2data/coophero.galaxy",
    "CoopHeroInit",
    "function",
    1,
  );
  database.prepare("INSERT INTO commander_profiles VALUES (?, ?)").run(
    "TerranRaynor",
    JSON.stringify({
      roster: {
        buildings: [],
        units: [{ techId: "HyperionVoidCoop", unitId: "HyperionVoidCoop", source: "PlayerCommanders.HeroUnit", links: [{ catalog: "Abil" }] }],
      },
      levelPerks: [{ level: 1, id: "Raynor", nameZhCN: "雷诺", links: [{ catalog: "Button" }] }],
      prestiges: [],
      masteries: [],
      panel: {
        traits: [
          { buttonId: "RaynorTrait", index: 0, nameZhCN: "游骑兵" },
          { buttonId: "Stimpack", index: 1, nameZhCN: "强化剂" },
        ],
        casterUnit: "CommandCenter",
        abilityCommands: [{ abilityId: "CommandCenterTrain", commandIndex: 0, index: 0 }],
        defaultUpgrades: ["Stimpack"],
      },
    }),
  );
  for (const [commanderId, name] of [["ProtossArtanis", "阿塔尼斯"], ["ProtossKarax", "凯拉克斯"]]) {
    database.prepare("INSERT INTO commander_profiles VALUES (?, ?)").run(
      commanderId,
      JSON.stringify({
        roster: {
          buildings: [{
            techId: "PhotonCannon",
            unitId: "PhotonCannon",
            nameZhCN: "光子炮台",
            nameEnUS: "Photon Cannon",
            source: "Commander.UnitArray",
            unlockedAtLevel: null,
          }],
          units: [],
        },
        levelPerks: [],
        prestiges: [],
        masteries: [],
        panel: { traits: [], casterUnit: null, abilityCommands: [], defaultUpgrades: [] },
        fixtureName: name,
      }),
    );
  }
  database.close();
  const plan = {
    formatVersion: 2,
    id: "raynor-marine-life-75",
    title: "Raynor Marine life 75",
    dependsOn: [],
    conflictsWith: [],
    operations: [{
      opId: "set-marine-life",
      kind: "commander.stat.set",
      commanderId: "TerranRaynor",
      catalog: "Unit",
      object: "Marine",
      path: "LifeMax",
      expect: 55,
      value: 75,
    }],
  };
  const receipt = {
    receiptVersion: 1,
    planId: plan.id,
    planSha256: "fixture-sha",
    appliedAt: "2026-08-09T00:00:00.000Z",
    operations: [{
      opId: "set-marine-life",
      kind: "commander.stat.set",
      target: "commander/TerranRaynor/stat/Unit/Marine/LifeMax",
      targets: ["commander/TerranRaynor/stat/Unit/Marine/LifeMax"],
      status: "changed",
      verified: true,
    }],
  };
  await writeFile(
    path.join(repoRoot, "game-a", "patches", `${plan.id}.patch-plan.json`),
    JSON.stringify(plan),
    "utf8",
  );
  await writeFile(
    path.join(repoRoot, "game-a", "patches", `${plan.id}.receipt.json`),
    JSON.stringify(receipt),
    "utf8",
  );
  const globalPlan = {
    formatVersion: 2,
    id: "global-marine-life-60",
    title: "Global Marine life 60",
    dependsOn: [],
    conflictsWith: [],
    operations: [{
      opId: "set-global-marine-life",
      kind: "catalog.set",
      catalog: "Unit",
      object: "Marine",
      path: "LifeMax",
      expect: 55,
      value: 60,
    }],
  };
  await writeFile(
    path.join(repoRoot, "game-a", "patches", `${globalPlan.id}.patch-plan.json`),
    JSON.stringify(globalPlan),
    "utf8",
  );
  await writeFile(
    path.join(repoRoot, "game-a", "patches", `${globalPlan.id}.receipt.json`),
    JSON.stringify({
      receiptVersion: 1,
      planId: globalPlan.id,
      planSha256: "fixture-global-sha",
      appliedAt: "2026-08-08T00:00:00.000Z",
      operations: [{
        opId: "set-global-marine-life",
        kind: "catalog.set",
        target: "catalog/Unit/Marine/LifeMax",
        status: "changed",
        verified: true,
      }],
    }),
    "utf8",
  );
  return { repoRoot, databaseFile, commanderAliasesFile };
}

test("galaxy.context returns bounded definitions, references, and proven Catalog IDs", async () => {
  const fixture = await createFixture();
  const search = createCoopSearch(fixture);

  const result = search.execute({
    operation: "galaxy.context",
    query: "SetHeroPanelUnit",
    commanderId: "TerranRaynor",
    detailLevel: "full",
  });

  assert.equal(result.operation, "galaxy.context");
  assert.equal(result.scope.commander.id, "TerranRaynor");
  assert.equal(result.lookup.referenceTerm, "libCOUI_gf_SetHeroPanelUnit");
  assert.equal(result.lookup.matchingSymbolNames, 1);
  assert.equal(result.definitions.length, 2);
  assert.ok(result.definitions.every((item) => item.name === "libCOUI_gf_SetHeroPanelUnit"));
  assert.ok(result.definitions.every((item) => item.line === 2 && item.indexedLine === 1));
  assert.ok(result.definitions.every((item) => item.snippet.text.includes("libCOUI_gf_SetHeroPanelUnit")));
  assert.deepEqual(
    result.references.map((item) => [item.sourceFile, item.line]),
    [["starcoop.sc2mod:base.sc2data/coophero.galaxy", 5]],
  );
  const hyperion = result.relatedCatalogObjects.find((item) =>
    item.catalog === "Unit" && item.objectId === "HyperionVoidCoop");
  assert.ok(hyperion);
  assert.equal(hyperion.commanderEvidence[0].depth, 0);
  assert.match(result.warnings[0], /not a complete Galaxy call graph/);

  const literal = search.execute({ operation: "galaxy.context", query: "HyperionVoidCoop", detailLevel: "full" });
  assert.equal(literal.definitions.length, 0);
  assert.equal(literal.references[0].line, 3);
  assert.equal(literal.relatedCatalogObjects[0].objectId, "HyperionVoidCoop");
  assert.ok(literal.warnings.some((warning) => warning.includes("No Galaxy symbol definition")));

  assert.throws(
    () => search.execute({ operation: "galaxy.context", query: "SetHeroPanelUnit", commanderId: "Missing" }),
    /Unknown commander/,
  );
  assert.throws(
    () => search.execute({ operation: "galaxy.context" }),
    /query is required/,
  );
});

test("Galaxy compact lookup finds native signatures/constants with at most two call examples, without modifying the database", async () => {
  const fixture = await createFixture();
  const db = new DatabaseSync(fixture.databaseFile);
  const columns = db.prepare("PRAGMA table_info(galaxy_files)").all();
  // Extend an existing fixture file so metadata columns remain intact.
  assert.ok(columns.some((c) => c.name === "contents"));
  const row = db.prepare("SELECT source_file FROM galaxy_files LIMIT 1").get();
  const content = ["native void RegisterTest(trigger t, int player);", "const int TestAnyPlayer = -1;",
    ...Array.from({ length: 12 }, (_, i) => `void TestCaller${i}() { RegisterTest(null, TestAnyPlayer); }`)].join("\n");
  db.prepare("UPDATE galaxy_files SET contents=? WHERE source_file=?").run(content, row.source_file);
  db.close();
  reindexGalaxySymbols(fixture.databaseFile);
  const before = await readFile(fixture.databaseFile);
  const search = createCoopSearch(fixture);
  const compact = search.execute({ operation: "galaxy.context", query: "RegisterTest" });
  assert.equal(compact.detailLevel, "overview");
  assert.equal(compact.definitions[0].kind, "native");
  assert.equal(compact.definitions[0].signature, "native void RegisterTest(trigger t, int player);");
  assert.deepEqual(compact.definitions[0].parameters, [{ type: "trigger", name: "t" }, { type: "int", name: "player" }]);
  assert.equal(compact.references.length, 2);
  assert.ok(compact.references.every((r) => r.line > 2));
  assert.equal("relatedCatalogObjects" in compact, false);
  assert.ok(!compact.warnings.some((s) => s.includes("reindex-galaxy")));
  const full = search.execute({ operation: "galaxy.context", query: "RegisterTest", detailLevel: "full" });
  assert.ok(full.references.length > compact.references.length);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 2);
  const constant = search.execute({ operation: "galaxy.context", query: "TestAnyPlayer" });
  assert.equal(constant.definitions[0].kind, "constant");
  assert.equal(constant.definitions[0].value, "-1");
  assert.equal(constant.definitions[0].type, "int");
  assert.deepEqual(await readFile(fixture.databaseFile), before);
});

test("search is a single dispatcher over bounded database operations", async () => {
  const fixture = await createFixture();
  const search = createCoopSearch(fixture);

  const status = search.execute({ operation: "status" });
  assert.equal(status.database.sc2Build, "BTEST");
  assert.equal(status.counts.catalogObjects, 23);

  const commander = search.execute({ operation: "commander.get", commanderId: "TerranRaynor" });
  assert.equal(commander.commander.nameZhCN, "雷诺");
  assert.deepEqual(commander.commander.aliases, ["游骑兵长"]);
  assert.equal(commander.roster.units[0].unitId, "HyperionVoidCoop");
  assert.equal("source" in commander.roster.units[0], false);
  assert.equal("links" in commander.levelPerks[0], false);
  assert.equal(commander.panel.traits[0].buttonId, "RaynorTrait");
  assert.deepEqual(commander.panel.abilityCommands, [
    { abilityId: "CommandCenterTrain", commandIndex: 0, index: 0, catalog: 'Abil', objectId: 'CommandCenterTrain' },
  ]);
  assert.deepEqual(commander.panel.defaultUpgrades, ["Stimpack"]);
  assert.deepEqual(commander.projection, {
    id: "commander",
    version: 1,
    detailLevel: "overview",
  });

  const fullCommander = search.execute({
    operation: "commander.get",
    commanderId: "TerranRaynor",
    detailLevel: "full",
  });
  assert.equal(fullCommander.projection.detailLevel, "full");
  assert.equal(fullCommander.roster.units[0].stats.unitId, "HyperionVoidCoop");
  assert.equal(fullCommander.roster.units[0].stats.lifeMax, 2000);
  assert.deepEqual(Object.keys(fullCommander.roster.units[0].details), [
    "weapons",
    "skills",
    "commanderUpgrades",
  ]);
  assert.throws(
    () => search.execute({
      operation: "commander.get",
      commanderId: "TerranRaynor",
      detailLevel: "raw",
    }),
    /detailLevel must be overview or full/,
  );

  const commanders = search.execute({ operation: "commander.list" });
  assert.deepEqual(commanders.items.find((item) => item.id === "TerranRaynor").aliases, ["游骑兵长"]);

  const resolvedAlias = search.execute({ operation: "commander.resolve", query: "游骑兵长" });
  assert.equal(resolvedAlias.resolved, true);
  assert.equal(resolvedAlias.commanderId, "TerranRaynor");
  assert.equal(resolvedAlias.candidates[0].matchedBy, "alias");
  assert.equal(resolvedAlias.candidates[0].matchType, "exact");

  const resolvedPrefix = search.execute({ operation: "commander.resolve", query: "游骑兵" });
  assert.equal(resolvedPrefix.resolved, true);
  assert.equal(resolvedPrefix.commanderId, "TerranRaynor");

  const resolvedSingleHanTypo = search.execute({ operation: "commander.resolve", query: "游骑兵涨" });
  assert.equal(resolvedSingleHanTypo.resolved, true);
  assert.equal(resolvedSingleHanTypo.commanderId, "TerranRaynor");
  assert.equal(resolvedSingleHanTypo.confidence, 0.9);
  assert.equal(resolvedSingleHanTypo.candidates[0].matchType, "fuzzy");

  const unresolved = search.execute({ operation: "commander.resolve", query: "不存在的名字" });
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.commanderId, null);
  assert.deepEqual(unresolved.candidates, []);

  const object = search.execute({ operation: "catalog.object", catalog: "Unit", objectId: "HyperionVoidCoop" });
  assert.equal(object.fields[0].value, "2000");

  const references = search.execute({
    operation: "catalog.references",
    catalog: "Unit",
    objectId: "HyperionVoidCoop",
    direction: "incoming",
  });
  assert.equal(references.incoming[0].sourceObjectId, "VoidCoopSummonHyperion");

  const creationTrace = search.execute({
    operation: "relationships.trace",
    catalog: "Unit",
    objectId: "SCV",
    commanderId: "TerranRaynor",
    direction: "incoming",
    relationFamily: "creation",
    maxDepth: 2,
    includeFields: true,
  });
  assert.equal(creationTrace.start.objectId, "SCV");
  assert.equal(creationTrace.commander.commanderId, "TerranRaynor");
  assert.equal(
    creationTrace.nodes.find((node) => node.objectId === "CommandCenter").commanderRelevance.relationship,
    "direct",
  );
  const trainEdge = creationTrace.edges.find((edge) => edge.relation.kind === "trains");
  assert.equal(trainEdge.source.objectId, "CommandCenterTrain");
  assert.equal(trainEdge.target.objectId, "SCV");
  assert.equal(
    trainEdge.contextFields.find((field) => field.path === "InfoArray[Train1].@Time").value,
    "17",
  );
  assert.equal(
    creationTrace.paths.some((tracePath) =>
      tracePath.end.objectId === "CommandCenter" &&
      tracePath.steps.map((step) => step.relation).join("/") === "trains/uses_ability"),
    true,
  );

  const combatTrace = search.execute({
    operation: "relationships.trace",
    catalog: "Unit",
    objectId: "Marine",
    direction: "outgoing",
    relationFamily: "combat",
    maxDepth: 3,
  });
  assert.deepEqual(
    combatTrace.paths.find((tracePath) => tracePath.end.objectId === "GaussDamage")
      .steps.map((step) => step.relation),
    ["uses_weapon", "runs_effect", "runs_effect"],
  );

  const resolvedEntity = search.execute({
    operation: "entity.resolve",
    query: "陆战队原",
    catalog: "Unit",
    commanderId: "TerranRaynor",
    limit: 3,
  });
  assert.equal(resolvedEntity.resolved, true);
  assert.equal(resolvedEntity.entity.objectId, "Marine");
  assert.equal(resolvedEntity.candidates[0].matchType, "fuzzy");

  const qualifiedEntity = search.execute({
    operation: "entity.resolve",
    query: "Upgrade/Stimpack",
  });
  assert.equal(qualifiedEntity.entity.catalog, "Upgrade");
  assert.equal(qualifiedEntity.entity.objectId, "Stimpack");

  const effective = search.execute({
    operation: "catalog.effective",
    catalog: "Unit",
    objectId: "Marine",
    path: "Radius",
  });
  assert.equal(effective.resolved, true);
  assert.equal(effective.field.value, 0.5);
  assert.equal(effective.field.inherited, true);
  assert.equal(effective.field.patchable, false, 'this legacy fixture has only a flattened default value; executable XML evidence is absent');

  const entity = search.execute({
    operation: "entity.get",
    detailLevel: "full",
    catalog: "Unit",
    objectId: "Marine",
    path: "LifeMax",
    fieldPrefix: "Life",
    direction: "outgoing",
    relationFamily: "combat",
  });
  assert.deepEqual(entity.projection, {
    id: "entity",
    version: 2,
    purpose: "bounded-authoring-evidence",
  });
  assert.equal(entity.entity.objectId, "Marine");
  assert.deepEqual(entity.fields.map((field) => field.path), ["LifeMax"]);
  assert.equal(entity.effectiveField.field.value, 55);
  assert.equal(entity.effectiveField.field.patchable, entity.editState.catalogEdit.available, 'field annotations must use the executable contract even for a flattened-only fixture');
  assert.equal(entity.relationships.edges[0].relation.kind, "uses_weapon");
  assert.equal(entity.relationships.edges[0].target.objectId, "GaussRifle");
  assert.equal(entity.unitArrays.abilities.nextFreeIndex, 2);
  assert.deepEqual(
    entity.unitArrays.abilities.slots.map((slot) => slot.attributes.Link),
    ["move", "attack"],
  );
  assert.equal(entity.unitArrays.commandCards[0].nextFreeIndex, 2);
  assert.equal(entity.unitArrays.commandCards[0].slots[0].attributes.Requirements, "HaveMove");
  assert.equal(entity.unitArrays.commandCards[0].slots[1].attributes.AbilCmd, "Stimpack,Execute");
  assert.equal(entity.unitArrays.semantics.numericSlotsRequired, true);

  const ordinalField = search.execute({
    operation: "catalog.effective",
    catalog: "Unit",
    objectId: "Marine",
    path: "CardLayouts[0].CardId",
  });
  assert.equal(ordinalField.exists, true);
  assert.equal(ordinalField.field.patchable, false);
  assert.equal(ordinalField.warnings[0].code, "ordinal-unindexed-element");

  const graph = search.execute({
    operation: "graph.slice",
    catalog: "Unit",
    objectId: "Marine",
    relationFamily: "combat",
    maxDepth: 3,
  });
  assert.equal(graph.nodesByCatalog.Effect.includes("GaussDamage"), true);
  assert.equal(
    graph.edges.some((edge) => edge.source.objectId === "GaussSet" && edge.relation.kind === "runs_effect"),
    true,
  );

  const impact = search.execute({
    operation: "impact.analyze",
    catalog: "Effect",
    objectId: "GaussDamage",
    maxDepth: 3,
  });
  assert.equal(impact.scope.enemyUsage, "unknown");
  assert.equal(impact.scope.nonCommanderImpact, "possible");
  assert.equal(impact.commanders[0].commanderId, "TerranRaynor");
  assert.equal(impact.unownedConsumers.some((item) => item.objectId === "EnemyMarine"), true);
  assert.deepEqual(impact.semanticImpact.targetKinds, ["effect"]);
  assert.equal(
    impact.semanticImpact.consumers.groups.some((group) => group.role === "effect-chain"),
    true,
  );
  assert.equal(
    impact.semanticImpact.dependencies.groups.some((group) => group.role === "applied-behavior"),
    true,
  );

  const abilityImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Abil",
    objectId: "CommandCenterTrain",
    scope: { kind: "commander", commanderId: "TerranRaynor" },
  });
  assert.deepEqual(abilityImpact.semanticImpact.targetKinds, ["ability", "panel"]);
  assert.equal(abilityImpact.semanticImpact.owners.classification, "profile-bound");
  assert.deepEqual(
    abilityImpact.semanticImpact.entrypoints.groups.map((group) => group.role),
    ["panel-ability-command", "unit-holder"],
  );
  assert.deepEqual(abilityImpact.directDependencies[0], {
    catalog: "Unit",
    objectId: "SCV",
    fieldPath: "InfoArray[Train1].Unit",
    relation: "trains",
    semanticRole: "created-unit",
    confidence: 1,
  });
  assert.equal(abilityImpact.semanticImpact.sharedDependencies.items[0].dependency.objectId, "SCV");
  assert.equal(
    abilityImpact.semanticImpact.sharedDependencies.items[0].sharingStatus,
    "requested-commander-only",
  );

  const behaviorImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Behavior",
    objectId: "StimpackBuff",
    scope: { kind: "commander", commanderId: "TerranRaynor" },
  });
  assert.deepEqual(behaviorImpact.semanticImpact.targetKinds, ["behavior"]);
  assert.equal(behaviorImpact.semanticImpact.entrypoints.groups[0].role, "effect-applier");
  assert.equal(behaviorImpact.semanticImpact.dependencies.groups[0].role, "trigger-effect");
  assert.equal(behaviorImpact.semanticImpact.sharedDependencies.items[0].dependency.objectId, "GaussSet");

  const weaponImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Weapon",
    objectId: "GaussRifle",
  });
  assert.deepEqual(weaponImpact.semanticImpact.targetKinds, ["weapon"]);
  assert.equal(
    weaponImpact.semanticImpact.entrypoints.groups.find((group) => group.role === "unit-holder").itemCount,
    2,
  );
  assert.equal(weaponImpact.semanticImpact.dependencies.groups[0].role, "damage-effect");

  const upgradeImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Upgrade",
    objectId: "Stimpack",
    scope: { kind: "commander", commanderId: "TerranRaynor" },
  });
  assert.deepEqual(upgradeImpact.semanticImpact.targetKinds, ["upgrade", "panel"]);
  assert.deepEqual(
    upgradeImpact.semanticImpact.entrypoints.groups.map((group) => group.role),
    ["panel-default-upgrade", "research-entry"],
  );
  assert.equal(
    upgradeImpact.semanticImpact.consumers.groups.some((group) => group.role === "requirement-gate"),
    true,
  );
  assert.equal(upgradeImpact.semanticImpact.dependencies.groups[0].role, "modified-unit");
  assert.equal(
    upgradeImpact.directConsumers.some((consumer) => consumer.relation === "researches_upgrade"),
    true,
  );

  const buildingImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Unit",
    objectId: "PhotonCannon",
  });
  assert.deepEqual(buildingImpact.semanticImpact.targetKinds, ["building"]);
  assert.equal(buildingImpact.semanticImpact.owners.classification, "shared-across-commanders");
  assert.equal(buildingImpact.semanticImpact.entrypoints.groups[0].role, "commander-roster");
  assert.equal(buildingImpact.semanticImpact.entrypoints.groups[0].itemCount, 2);

  const isolatedImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Effect",
    objectId: "GaussDamage",
    owner: { catalog: "Unit", objectId: "Marine" },
    scope: { kind: "commander", commanderId: "TerranRaynor" },
    changeType: "structural",
    includeIsolationPlan: true,
    maxDepth: 3,
  });
  assert.equal(isolatedImpact.isolation.evidenceStatus, "possible-leak");
  assert.equal(isolatedImpact.isolation.recommendedStrategy, "private-clone");
  assert.deepEqual(
    isolatedImpact.isolation.ownerPaths[0].nodes.map((node) => `${node.catalog}/${node.objectId}`),
    ["Unit/Marine", "Weapon/GaussRifle", "Effect/GaussSet", "Effect/GaussDamage"],
  );
  assert.deepEqual(
    isolatedImpact.isolation.cloneCandidates.map((item) => `${item.catalog}/${item.sourceObjectId}`),
    ["Unit/Marine", "Weapon/GaussRifle", "Effect/GaussSet", "Effect/GaussDamage"],
  );
  assert.equal(
    isolatedImpact.isolation.outsideScopeConsumers.some((item) => item.objectId === "EnemyMarine"),
    true,
  );
  assert.deepEqual(isolatedImpact.isolation.rewireCandidates[0], {
    catalog: "Unit",
    objectId: "GameATerranRaynorMarine",
    path: "WeaponArray[0].Link",
    patchable: false,
    reason: "executor-value-unresolved",
    suggestedValue: "GameATerranRaynorGaussRifle",
    relation: "uses_weapon",
  });

  const scalarImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Unit",
    objectId: "Marine",
    path: "LifeMax",
    owner: { catalog: "Unit", objectId: "Marine" },
    scope: { kind: "commander", commanderId: "TerranRaynor" },
    changeType: "scalar",
    includeIsolationPlan: true,
  });
  assert.equal(scalarImpact.isolation.recommendedStrategy, "player-upgrade");
  assert.deepEqual(scalarImpact.isolation.cloneCandidates, []);

  const unitOwnerImpact = search.execute({
    operation: "impact.analyze",
    catalog: "Unit",
    objectId: "SCV",
    owner: { catalog: "Unit", objectId: "SCV" },
    scope: { kind: "commander", commanderId: "TerranRaynor" },
    changeType: "structural",
    includeIsolationPlan: true,
    maxDepth: 2,
  });
  assert.equal(unitOwnerImpact.isolation.recommendedStrategy, "private-clone",
    'bounded lack of outside consumers must not bypass default private authoring');
  assert.equal(unitOwnerImpact.isolation.ownerEntrypoints.summary.creation, 2);
  assert.deepEqual(
    unitOwnerImpact.isolation.ownerEntrypoints.creation.map((entry) =>
      `${entry.source.catalog}/${entry.source.objectId}`),
    ["Abil/CommandCenterTrain", "Unit/CommandCenter"],
  );
  assert.deepEqual(unitOwnerImpact.isolation.rewireCandidates, [{
    catalog: "Abil",
    objectId: "CommandCenterTrain",
    path: "InfoArray[Train1].Unit[0]",
    expect: "SCV",
    suggestedValue: "GameATerranRaynorSCV",
    relation: "trains",
    reviewRequired: false,
    mechanism: "commander.unit.clone.redirects",
  }]);
  assert.equal(
    unitOwnerImpact.isolation.ownerEntrypoints.creation[1].paths[0].patchable,
    false,
  );

  const requirement = search.execute({
    operation: "requirement.explain",
    catalog: "Requirement",
    objectId: "LearnStimpack",
    maxDepth: 8,
  });
  assert.equal(requirement.partial, false);
  assert.equal(requirement.phases[0].phase, "Show");
  assert.equal(requirement.phases[0].expression.kind, "all");
  assert.equal(requirement.phases[0].expression.children[0].subjectCatalog, "Unit");
  assert.equal(requirement.phases[0].expression.children[1].child.subjectCatalog, "Upgrade");
  assert.equal(requirement.phases[0].expression.children[1].child.subject, "Stimpack");

  const history = search.execute({
    operation: "patches.for_target",
    target: "commander/TerranRaynor/stat/Unit/Marine/LifeMax",
  });
  assert.equal(history.matchCount, 2);
  assert.equal(history.latest.planId, "raynor-marine-life-75");
  assert.equal(history.latest.operation.expect, 55);
  assert.equal(history.latest.operation.value, 75);
  assert.deepEqual(history.suggestedDependsOn, ["raynor-marine-life-75"]);
  assert.equal(history.semanticOverlaps[0].planId, "global-marine-life-60");

  const found = search.execute({ operation: "catalog.search", query: "Hyperion" });
  assert.equal(found.items[0].key, "Unit/HyperionVoidCoop");

  const heroOwners = search.execute({ operation: "commanders_for_unit", unitId: "hyperionvoidcoop" });
  assert.equal(heroOwners.unit.unitId, "HyperionVoidCoop");
  assert.equal(heroOwners.ownership, "exclusive");
  assert.equal(heroOwners.sharedAcrossCommanders, false);
  assert.equal(heroOwners.owners[0].commanderId, "TerranRaynor");
  assert.deepEqual(heroOwners.owners[0].relationships, ["hero"]);
  assert.equal(heroOwners.relatedCommanders[0].commanderId, "ProtossKarax");

  const sharedOwners = search.execute({ operation: "commanders_for_unit", unitId: "PhotonCannon" });
  assert.equal(sharedOwners.ownership, "shared");
  assert.equal(sharedOwners.ownerCount, 2);
  assert.deepEqual(
    sharedOwners.owners.map((owner) => owner.commanderId),
    ["ProtossArtanis", "ProtossKarax"],
  );
  assert.equal(sharedOwners.owners.every((owner) => owner.relationships.includes("roster_building")), true);

  assert.throws(
    () => search.execute({ operation: "commanders_for_unit", unitId: "MissingUnit" }),
    /Unknown Unit object/,
  );
  assert.throws(() => search.execute({ operation: "not-a-real-operation" }), CoopSearchError);
});
