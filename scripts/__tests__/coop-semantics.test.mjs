import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildCoopSemantics, readCoopEntityFacts, readCoopCommanderFacts, semanticStatus } from '../lib/coop-semantics.mjs';
import { describeField } from '../lib/field-vocabulary.mjs';
import { readObjectParameters } from '../lib/object-parameters.mjs';

// Entirely synthetic data. No extracted SC2 data shipped as a fixture.
test('cached details and object parameters use the same class-aware scalar meanings',()=>withFixture(db=>{
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)').run('Effect','HitA','AreaArray[0].@Radius','6','synthetic.xml','HitA',0);
  buildCoopSemantics(db);
  let checked=0;
  for(const row of db.prepare('SELECT record_json FROM coop_semantic_details').all()) {
    for(const node of JSON.parse(row.record_json).nodes) {
      const page=readObjectParameters(db,{catalog:node.catalog,objectId:node.objectId,limit:100});
      for(const scalar of node.scalars) {
        const meaning=describeField(node.catalog,node.class,scalar.field.path);
        assert.equal(meaning.kind,'scalar');assert.equal(scalar.label,meaning.label);
        assert.equal(page.entries.find(e=>e.path===scalar.field.path)?.label,scalar.label);checked++;
      }
    }
  }
  assert.ok(checked>0);
  const hit=readObjectParameters(db,{catalog:'Effect',objectId:'HitA'});
  assert.equal(hit.entries.find(e=>e.sourcePath==='AreaArray[0].@Radius').label,'区域半径');
  assert.equal(describeField('Effect','CEffectUserData','Amount').status,'unknown','do not preserve the old blanket damage interpretation');
}));

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES ('sc2Build','BSYNTH'),('cascManifestSha256','synthetic-source');
    CREATE TABLE catalog_objects(catalog TEXT,object_id TEXT,class TEXT,PRIMARY KEY(catalog,object_id));
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT,source_file TEXT,
      origin_object_id TEXT,inheritance_depth INTEGER,PRIMARY KEY(catalog,object_id,path));
    CREATE TABLE localized_text(locale TEXT,text_key TEXT,value TEXT);
    CREATE TABLE commanders(id TEXT,commander_object_id TEXT);
    INSERT INTO commanders VALUES ('CommanderA','A'),('CommanderB','B');
    CREATE TABLE commander_profiles(commander_id TEXT,profile_json TEXT);
    CREATE TABLE commander_membership(commander_id TEXT,catalog TEXT,object_id TEXT,evidence TEXT,depth INTEGER);
    INSERT INTO commander_membership VALUES ('CommanderA','Unit','FactoryA','typed-userdata',0),
      ('CommanderB','Unit','FactoryB','typed-userdata',0);
  `);
  const obj = db.prepare('INSERT INTO catalog_objects VALUES (?,?,?)');
  const field = db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)');
  const add = (catalog,id,cls,fs={}) => {
    obj.run(catalog,id,cls);
    for (const [path,value] of Object.entries(fs)) field.run(catalog,id,path,String(value),'synthetic.xml',id,0);
  };
  add('Unit','ScoutA','CUnit',{'CostResource[Minerals]':31,'CostResource[Vespene]':47,Food:-3,
    'AbilArray.@Link':'PulseA','CardLayouts.LayoutButtons.@AbilCmd':'PulseA,Execute','CardLayouts.LayoutButtons.@Face':'PulseButton'});
  add('Unit','Scout','CUnit',{'CostResource[Vespene]':999});
  add('Unit','CarrierA','CUnit',{'CostResource[Minerals]':800,'BehaviorArray.@Link':'SpawnA'});
  add('Unit','FactoryA','CUnit',{'AbilArray.@Link':'TrainA','TechTreeProducedUnitArray':'Scout'});
  add('Unit','FactoryB','CUnit',{'AbilArray.@Link':'TrainB'});
  add('Unit','UnpricedA','CUnit',{'CostResource[Minerals]':17});
  add('Unit','BrokenACGluescreenDummy','CUnit');
  add('Abil','TrainA','CAbilTrain',{'InfoArray[Train1].@Unit':'CarrierA',
    'InfoArray[Train1].Resource[Minerals]':93,'InfoArray[Train1].Resource[Vespene]':141,
    'InfoArray[Train1].@Time':13,'InfoArray[Train1].Button.@Requirements':'NeedA',
    'InfoArray[Train2].Unit':'UnpricedA'});
  add('Abil','TrainB','CAbilTrain',{'InfoArray[Train1].Unit':'ScoutA','InfoArray[Train1].Resource[Vespene]':999});
  add('Behavior','SpawnA','CBehaviorBuff',{InitialEffect:'SpawnSet'});
  add('Effect','SpawnSet','CEffectSet',{'EffectArray[0]':'CreateA','EffectArray[1]':'LoopA'});
  add('Effect','LoopA','CEffectSet',{'EffectArray':'SpawnSet'});
  add('Effect','CreateA','CEffectCreateUnit',{SpawnUnit:'ScoutA',SpawnCount:3});
  add('Abil','PulseA','CAbilEffectTarget',{'Cost.Vital[Energy]':11,'Cost.Cooldown.TimeUse':0.125,
    Effect:'HitA','CmdButtonArray[Execute].Requirements':'NeedA'});
  add('Effect','HitA','CEffectDamage',{Amount:19});
  add('Upgrade','DiscountA','CUpgrade',{'EffectArray[0].@Reference':'Abil,TrainA,InfoArray[Train1].Resource[Vespene]',
    'EffectArray[0].@Value':12,'EffectArray[0].@Operation':'Subtract',
    'EffectArray[1].@Reference':'Unit,ScoutA,LifeMax','EffectArray[1].@Value':7});
  add('Upgrade','DuplicateProjection','CUpgrade',{'EffectArray.@Reference':'Unit,ScoutA,LifeMax',
    'EffectArray.@Value':1,'EffectArray[0].@Reference':'Unit,ScoutA,LifeMax','EffectArray[0].@Value':2});
  add('Upgrade','LegacyValue','CUpgrade',{'EffectArray[0].@Reference':'Unit,ScoutA,LifeMax','EffectArray[0]':23});
  db.prepare('INSERT INTO localized_text VALUES (?,?,?)').run('zhcn','Button/Name/PulseButton','测试脉冲');
  const p = { roster:{units:[{unitId:'ScoutA',nameZhCN:'侦察者',source:'synthetic-roster'},
    {unitId:'UnpricedA',nameZhCN:'未标价者'},{unitId:'BrokenACGluescreenDummy'}],buildings:[]},
    prestiges:[{id:'DiscountA',index:1}],levelPerks:[],masteries:[] };
  db.prepare('INSERT INTO commander_profiles VALUES (?,?)').run('CommanderA',JSON.stringify(p));
  db.prepare('INSERT INTO commander_profiles VALUES (?,?)').run('CommanderB',JSON.stringify({roster:{units:[{unitId:'Scout',nameZhCN:'侦察者'}]}}));
  return db;
}
const read = (db,extra={}) => readCoopEntityFacts(db,{commanderId:'CommanderA',objectId:'ScoutA',topic:'production',...extra});
function withFixture(fn) { const db=fixture(); try { return fn(db); } finally { db.close(); } }

test('commander roots enumerate every profile entry, including missing and presentation-only effects',()=>withFixture(db=> {
  const p=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('CommanderA').profile_json);
  p.masteries=[{id:'MasteryA',links:[{catalog:'Upgrade',objectId:'LegacyValue'}]},
    {id:'MissingMastery',links:[{catalog:'Upgrade',objectId:'Absent'}]}];
  p.levelPerks=[{id:'DisplayOnly',links:[]},{id:'Mixed',links:[{catalog:'Upgrade',objectId:'LegacyValue'}, {catalog:'Upgrade',objectId:'Absent'}]}];
  p.panel={casterUnit:'FactoryA',defaultUpgrades:['DuplicateProjection'],traits:[{buttonId:'AbsentButton'}],
    abilityCommands:[{abilityId:'TrainB',commandIndex:0}]};
  db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(p),'CommanderA');
  buildCoopSemantics(db);
  const root=readCoopCommanderFacts(db,{commanderId:'A'});
  assert.equal(root.kind,'commander-directory');
  assert.equal(root.coverage.counts.masteries.total,2);
  assert.equal(root.coverage.counts.masteries.partial,1);
  assert.equal(root.coverage.counts.masteries.unresolved,1);
  assert.equal(root.coverage.counts.levelPerks.allEffectTargetsIndexed,0);
  const entries=readCoopEntityFacts(db,{...root.sections.find(s=>s.section==='masteries').nextQuery,limit:1});
  assert.equal(entries.nextOffset,1);
  assert.equal(entries.entries[0].coverage.navigation,'resolved');
  assert.equal(entries.entries[0].coverage.status,'partial');
  assert.equal(readCoopEntityFacts(db,entries.entries[0].targets[0].nextQuery).kind,'object-details');
  const missing=readCoopEntityFacts(db,{...root.sections.find(s=>s.section==='masteries').nextQuery,offset:1}).entries[0];
  assert.equal(missing.targets[0].nextQuery,undefined);
  assert.ok(missing.coverage.gaps.includes('missing-target'));
  assert.equal(readCoopEntityFacts(db,{commanderId:'A',catalog:'Unit',objectId:'FactoryA'}).kind,'unit-directory');
  const panel=readCoopCommanderFacts(db,{commanderId:'A',topic:'panelAbilities'}).entries[0];
  assert.equal(panel.targets[0].commandIndex,0);
  assert.equal(panel.targets[0].nextQuery.commandIndex,undefined,'profile ordinals are not Catalog slot IDs');
  assert.equal(readCoopEntityFacts(db,{commanderId:'A',catalog:'Commander',objectId:'B'}).status,'not-indexed');
  assert.throws(()=>readCoopCommanderFacts(db,{commanderId:'A',topic:'madeUp'}),/Unknown/);
  assert.throws(()=>readCoopCommanderFacts(db,{commanderId:'A',limit:0}),/pagination/);
  assert.equal(readCoopCommanderFacts(db,{commanderId:'A',entryId:'MasteryA'}).entries[0].targets[0].objectId,'LegacyValue');
}));

test('research is independently rooted from profile abilities with exact command and Upgrade queries',()=>withFixture(db=> {
  db.exec("INSERT INTO catalog_objects VALUES ('Abil','ResearchA','CAbilResearch')");
  const put=db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)');
  for(const [path,value] of Object.entries({'InfoArray[Research1].Upgrade':'LegacyValue','InfoArray[Research1].Time':'17',
    'InfoArray[Research2].Upgrade':'DiscountA','InfoArray[Research2].Time':'29'})) put.run('Abil','ResearchA',path,value,'synthetic.xml','ResearchA',0);
  const p=JSON.parse(db.prepare('SELECT profile_json FROM commander_profiles WHERE commander_id=?').get('CommanderA').profile_json);
  p.levelPerks=[{id:'ResearchUnlock',links:[{catalog:'Abil',objectId:'ResearchA',commandIndex:0}]}];
  db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(p),'CommanderA');
  buildCoopSemantics(db);
  const r=readCoopCommanderFacts(db,{commanderId:'A',topic:'research'});
  assert.equal(r.total,2);
  const command=readCoopEntityFacts(db,r.entries[0].targets[0].nextQuery);
  assert.equal(command.commandIndex,'Research1');
  assert.deepEqual(command.scalars.map(s=>s.value),[17]);
  assert.equal(readCoopEntityFacts(db,r.entries[0].targets[1].nextQuery).scalars[0].operand,23);
  assert.equal(r.entries[0].coverage.allEffectTargetsIndexed,true);
  assert.equal(r.entries[0].coverage.runtimeEvaluated,false);
}));

test('commander index is deterministic, source-only and rolls back on late failure',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const snapshot=()=>db.prepare('SELECT * FROM coop_semantic_commanders ORDER BY commander_id').all();
  const before=snapshot();
  buildCoopSemantics(db); assert.deepEqual(snapshot(),before);
  db.exec("CREATE TRIGGER reject_commander BEFORE INSERT ON coop_semantic_commanders BEGIN SELECT RAISE(ABORT,'late failure'); END");
  assert.throws(()=>buildCoopSemantics(db),/late failure/);
  assert.deepEqual(snapshot(),before);
  assert.equal(semanticStatus(db).status,'ready');
  db.exec("UPDATE coop_semantic_meta SET value='2' WHERE key='version'");
  assert.equal(readCoopCommanderFacts(db,{commanderId:'A'}).status,'stale');
}));

test('old database returns actionable missing status without writes',()=>withFixture(db=> {
  assert.equal(semanticStatus(db).status,'missing');
  assert.equal(read(db).semanticIndex.status,'missing');
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'coop_semantic_%'").get().n,0);
}));

test('production follows real ability and initial-spawn path, not generic tech tree',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const r=read(db);
  assert.equal(r.entity.objectId,'ScoutA');
  assert.equal(r.production.length,1);
  const p=r.production[0];
  assert.equal(p.abilityId,'TrainA');
  assert.equal(p.resource.Vespene.value,141);
  assert.equal(p.resource.Vespene.field.path,'InfoArray[Train1].Resource[Vespene]');
  assert.equal(p.outputPaths[0].count,3);
  assert.equal(p.outputPaths[0].chain.at(-1).objectId,'CreateA');
  assert.equal(p.outputPaths[0].executionVerified,false);
  assert.equal(p.perUnitPriceComputed,false);
  assert.equal(p.scopeVerified,false);
  assert.equal(p.requirements[0].value,'NeedA');
  assert.equal(r.entity.catalogFacts['CostResource[Vespene]'].value,47);
}));

test('exact commander/object IDs never resolve names or fall back to generic units',()=>withFixture(db=> {
  buildCoopSemantics(db);
  assert.equal(readCoopEntityFacts(db,{commanderId:'A',objectId:'ScoutA'}).entity.objectId,'ScoutA');
  assert.equal(readCoopEntityFacts(db,{commanderId:'B',objectId:'Scout'}).entity.objectId,'Scout');
  assert.equal(read(db,{objectId:'Scout'}).status,'not-indexed');
  assert.equal(read(db,{objectId:'侦察者'}).status,'not-indexed');
  assert.throws(()=>read(db,{query:'侦察者'}),/resolve the target ID first/);
  assert.throws(()=>read(db,{objectId:undefined}),/resolve the target ID first/);
  assert.equal(read(db,{objectId:'BrokenACGluescreenDummy'}).entity.identity.status,'display-object-unresolved');
}));

test('missing resource and fields remain unknown, not zero or guessed fallback',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const r=read(db,{objectId:'UnpricedA'});
  assert.equal(r.production[0].resource.Minerals.value,null);
  assert.equal(r.production[0].resource.Minerals.status,'missing-not-zero');
  assert.equal(r.entity.catalogFacts['CostResource[Minerals]'].value,17);
  assert.equal(r.entity.catalogFacts.Food.value,null);
}));

test('abilities keep raw cooldown and requirements without claiming unlock or cooldown rule',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const r=read(db,{topic:'abilities'});
  const a=r.abilities[0];
  assert.equal(a.commands[0].name,'测试脉冲');
  assert.equal(a.numericFields.find(f=>f.path==='Cost.Cooldown.TimeUse').value,'0.125');
  assert.equal(a.availability,'attached-not-proven-unlocked');
  assert.equal(a.cooldownMeaning,'raw-field-not-complete-runtime-rule');
  assert.equal(a.requirements[0].value,'NeedA');
}));

test('Upgrade parameter and profile condition are candidates, with exact attribute path',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const r=read(db,{topic:'modifiers'});
  const m=r.modifiers.find(m=>m.upgradeId==='DiscountA' && m.entryIndex==='0');
  assert.equal(m.operation,'Subtract');
  assert.equal(m.parameter.path,'EffectArray[0].@Value');
  assert.equal(m.contexts[0].kind,'prestiges');
  assert.equal(m.contexts[0].index,1);
  assert.equal(m.activationVerified,false);
  assert.equal(r.modifiers.find(m=>m.upgradeId==='DiscountA' && m.entryIndex==='1').operation,null);
  assert.equal(r.modifiers.filter(m=>m.upgradeId==='DuplicateProjection').length,2);
  const legacy=r.modifiers.find(m=>m.upgradeId==='LegacyValue');
  assert.equal(legacy.operand,23);
  assert.equal(legacy.parameter.path,'EffectArray[0].@Value');
  assert.equal(legacy.parameter.sourcePath,'EffectArray[0]');
}));

test('explicit array override wins over inherited ordinal slot; cleared links are excluded',()=>withFixture(db=> {
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)').run('Unit','ScoutA','AbilArray[0].@Link','TrainA','child.xml','ScoutA',0);
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)').run('Unit','ScoutA','AbilArray[1].@Link','','child.xml','ScoutA',0);
  buildCoopSemantics(db);
  const a=read(db,{topic:'abilities'}).abilities;
  assert.deepEqual(a.map(a=>a.objectId),['TrainA']);
  assert.equal(a[0].attachment.path,'AbilArray[0].@Link');
}));

test('topic lists are paginated but there is no implicit entity search',()=>withFixture(db=> {
  buildCoopSemantics(db);
  assert.throws(()=>readCoopEntityFacts(db,{commanderId:'A',limit:1}),/exact objectId/);
  const mods=read(db,{topic:'modifiers',limit:1});
  assert.equal(mods.modifiers.length,1); assert.equal(mods.nextOffset,1);
  const next=read(db,{topic:'modifiers',limit:1,offset:1});
  assert.notDeepEqual(next.modifiers,mods.modifiers);
  assert.throws(()=>read(db,{limit:0}),/pagination/);
}));

test('queries use main baseline even if temporary engine/project fields shadow source',()=>withFixture(db=> {
  buildCoopSemantics(db);
  db.exec('CREATE TEMP TABLE catalog_fields AS SELECT * FROM main.catalog_fields');
  db.exec("UPDATE temp.catalog_fields SET value='9999'");
  const r=read(db);
  assert.equal(r.entity.catalogFacts['CostResource[Minerals]'].value,31);
  assert.equal(r.currentProjectIncluded,false);
  assert.equal(r.coverage.runtimeEvaluated,false);
  db.exec("INSERT INTO meta VALUES ('engineLatestSnapshot','new-engine-observation')");
  assert.equal(semanticStatus(db).status,'ready');
  assert.throws(()=>read(db,{prestigeUpgrade:'DiscountA'}),/baseline only/);
}));

test('rebuild is deterministic and leaves raw facts unchanged',()=>withFixture(db=> {
  const raw=()=>db.prepare('SELECT * FROM main.catalog_fields ORDER BY catalog,object_id,path').all();
  const source=raw();
  const first=buildCoopSemantics(db), a=JSON.stringify(read(db,{topic:'modifiers'}));
  assert.deepEqual(buildCoopSemantics(db),first);
  assert.equal(JSON.stringify(read(db,{topic:'modifiers'})),a);
  assert.deepEqual(raw(),source);
}));

test('failed rebuild rolls back all derived tables to the previous complete index',()=>withFixture(db=> {
  buildCoopSemantics(db); const before=read(db);
  db.exec("CREATE TRIGGER reject_semantic BEFORE INSERT ON coop_semantic_entities BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>buildCoopSemantics(db),/test failure/);
  assert.deepEqual(read(db),before);
}));

test('version/source mismatch rejects stale records rather than returning old facts',()=>withFixture(db=> {
  buildCoopSemantics(db);
  db.exec("UPDATE coop_semantic_meta SET value='0' WHERE key='version'");
  assert.equal(read(db).semanticIndex.status,'stale');
  buildCoopSemantics(db);
  db.exec("UPDATE meta SET value='BNEW' WHERE key='sc2Build'");
  assert.equal(read(db).semanticIndex.status,'stale');
}));

function extraObject(db,c,id,cls,fields={}) {
  db.prepare('INSERT INTO catalog_objects VALUES (?,?,?)').run(c,id,cls);
  for(const [p,v] of Object.entries(fields)) extraField(db,c,id,p,v);
}
function extraField(db,c,id,p,v) {
  db.prepare('INSERT OR REPLACE INTO catalog_fields VALUES (?,?,?,?,?,?,?)').run(c,id,p,String(v),'synthetic-extra.xml',id,0);
}

test('level one is a compact directory with runnable child and scalar queries',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const r=read(db,{topic:'overview'});
  assert.equal(r.kind,'unit-directory');
  assert.equal(r.production,undefined);
  assert.equal(r.directory.skills[0].target.objectId,'PulseA');
  assert.equal(r.directory.skills[0].name,'测试脉冲');
  assert.deepEqual(r.directory.skills[0].nextQuery,{operation:'entity.get',commanderId:'CommanderA',catalog:'Abil',objectId:'PulseA'});
  const child=readCoopEntityFacts(db,r.directory.skills[0].nextQuery);
  assert.equal(child.kind,'object-details');
  const damage=child.scalars.find(s=>s.field.objectId==='HitA');
  assert.equal(damage.value,19);
  assert.deepEqual(damage.nextQuery,{operation:'entity.get',commanderId:'CommanderA',catalog:'Effect',objectId:'HitA',path:'Amount'});
  const population=r.directory.attributes.find(a=>a.field.path==='Food');
  assert.equal(population.value,-3); assert.equal(population.nextQuery.path,'Food');
}));

test('weapon detail follows execution chains and overridden area effects, not display damage',()=>withFixture(db=> {
  extraField(db,'Unit','ScoutA','WeaponArray.@Link','OldWeapon');
  extraField(db,'Unit','ScoutA','WeaponArray[0].@Link','NewWeapon');
  extraObject(db,'Weapon','OldWeapon','CWeapon',{Effect:'OldDamage'});
  extraObject(db,'Weapon','NewWeapon','CWeapon',{Effect:'ShotSet',DisplayEffect:'OldDamage',Period:2,Range:9});
  extraObject(db,'Effect','ShotSet','CEffectSet',{'EffectArray[0]':'AreaSearch','EffectArray[1]':'ShotSet'});
  extraObject(db,'Effect','AreaSearch','CEffectEnumArea',{'AreaArray[#0].@Effect':'OldDamage','AreaArray[0].@Effect':'NewDamage'});
  extraObject(db,'Effect','OldDamage','CEffectDamage',{Amount:999});
  extraObject(db,'Effect','NewDamage','CEffectDamage',{Amount:7,'AttributeBonus[Armored]':3});
  buildCoopSemantics(db);
  const w=read(db,{topic:'overview'}).directory.weapons;
  assert.deepEqual(w.map(w=>w.target.objectId),['NewWeapon']);
  const r=readCoopEntityFacts(db,w[0].nextQuery);
  assert.equal(r.scalars.find(s=>s.field.objectId==='NewDamage' && s.field.path==='Amount').value,7);
  assert.equal(r.scalars.some(s=>s.field.objectId==='OldDamage'),false);
  assert.equal(r.effectGraph.nodes.length,4);
  assert.equal(r.coverage.executionMultiplicityEvaluated,false);
  assert.ok(r.unresolved.some(u=>u.reason==='display-reference-is-not-execution'));
}));

test('ability details automatically traverse applied behaviors and their numeric modifiers',()=>withFixture(db=> {
  extraField(db,'Abil','PulseA','Effect','ApplySlow');
  extraObject(db,'Effect','ApplySlow','CEffectApplyBehavior',{Behavior:'SlowA'});
  extraObject(db,'Behavior','SlowA','CBehaviorBuff',{Duration:8,'Modification.@MoveSpeedMultiplier':0.5});
  buildCoopSemantics(db);
  const r=readCoopEntityFacts(db,{commanderId:'CommanderA',catalog:'Abil',objectId:'PulseA'});
  const speed=r.scalars.find(s=>s.field.objectId==='SlowA' && s.field.path.includes('MoveSpeedMultiplier'));
  assert.equal(speed.value,0.5); assert.equal(speed.nextQuery.catalog,'Behavior');
}));

test('production directory carries commandIndex and excludes other command effects in detail',()=>withFixture(db=> {
  extraField(db,'Abil','TrainA','InfoArray[Train1].Effect','HitA');
  extraField(db,'Abil','TrainA','InfoArray[Train2].Effect','OtherHit');
  extraObject(db,'Effect','OtherHit','CEffectDamage',{Amount:999});
  buildCoopSemantics(db);
  const q=read(db,{topic:'overview'}).directory.production[0].nextQuery;
  assert.equal(q.commandIndex,'Train1');
  const r=readCoopEntityFacts(db,q);
  assert.ok(r.production.every(p=>p.commandIndex==='Train1'));
  assert.ok(r.scalars.some(s=>s.field.objectId==='HitA'));
  assert.ok(r.scalars.every(s=>s.field.objectId!=='OtherHit'));
  assert.throws(()=>readCoopEntityFacts(db,{...q,commandIndex:'Train9'}),/Unknown.*commandIndex/);
}));

test('explicit morph target has a navigable Unit directory, not just a dangling ID',()=>withFixture(db=> {
  extraField(db,'Unit','ScoutA','AbilArray[1].@Link','MorphA');
  extraObject(db,'Abil','MorphA','CAbilMorph',{'InfoArray[0].Unit':'ScoutAlternate'});
  extraObject(db,'Unit','ScoutAlternate','CUnit',{LifeMax:222});
  buildCoopSemantics(db);
  const form=read(db,{topic:'overview'}).directory.forms[0];
  const r=readCoopEntityFacts(db,form.nextQuery);
  assert.equal(r.kind,'unit-directory');
  assert.equal(r.directory.attributes.find(s=>s.field.path==='LifeMax').value,222);
}));

test('behavior and weapon slots never inherit unrelated AbilArray entries',()=>withFixture(db=> {
  extraField(db,'Unit','ScoutA','BehaviorArray[0].@Link','SpawnA');
  buildCoopSemantics(db);
  const r=read(db,{topic:'overview'});
  assert.deepEqual(r.directory.passives.map(p=>p.target.objectId),['SpawnA']);
  assert.equal(r.directory.weapons.length,0);
}));

test('Upgrade child returns exact editable parameter and unresolved operation metadata',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const child=read(db,{topic:'overview'}).directory.upgrades.find(u=>u.target.objectId==='DiscountA');
  const r=readCoopEntityFacts(db,child.nextQuery);
  assert.equal(r.scalars[0].parameter.path,'EffectArray[0].@Value');
  assert.equal(r.scalars[0].operation,'Subtract');
  assert.equal(r.scalars[1].operation,null);
}));

test('detail scalar pages preserve all owner fields without expanding on first level',()=>withFixture(db=> {
  buildCoopSemantics(db);
  const q={commanderId:'CommanderA',catalog:'Abil',objectId:'PulseA',limit:1};
  const r=readCoopEntityFacts(db,q);
  assert.equal(r.scalars.length,1); assert.equal(r.nextOffset,1);
  const next=readCoopEntityFacts(db,{...q,offset:r.nextOffset});
  assert.notDeepEqual(next.scalars,r.scalars);
}));
