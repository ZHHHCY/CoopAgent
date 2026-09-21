import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createFieldInfluenceReader } from '../lib/field-influences.mjs';
import { commanderStatIdentity } from '../../../scripts/lib/patch-plan-executor.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('sc2Build','TEST');
    CREATE TABLE catalog_objects(catalog TEXT,object_id TEXT,class TEXT,parent_id TEXT,is_default INTEGER,source_file TEXT,direct_xml TEXT);
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT,source_file TEXT,origin_object_id TEXT,inheritance_depth INTEGER);
    CREATE TABLE object_references(source_catalog TEXT,source_object_id TEXT,field_path TEXT,target_catalog TEXT,target_object_id TEXT,confidence REAL,evidence TEXT);
    CREATE INDEX reverse_target ON object_references(target_catalog,target_object_id);
    CREATE TABLE localized_text(locale TEXT,text_key TEXT,value TEXT);
    CREATE TABLE commander_profiles(commander_id TEXT,profile_json TEXT);`);
  const obj = (c,id,{ parent=null, template=0, cls='C'+c }={}) => db.prepare('INSERT INTO catalog_objects VALUES(?,?,?,?,?,?,?)').run(c,id,cls,parent,template,'synthetic.xml','<C'+c+'/>');
  const field = (c,id,p,v) => db.prepare('INSERT INTO catalog_fields VALUES(?,?,?,?,?,?,?)').run(c,id,p,String(v),'synthetic.xml',id,0);
  const ref = (c,id,p,tc,ti) => db.prepare('INSERT INTO object_references VALUES(?,?,?,?,?,?,?)').run(c,id,p,tc,ti,1,'synthetic');
  const upgrade = (id,path='LifeMax',value=40,operation='Add',options={}) => {
    obj('Upgrade',id,options); field('Upgrade',id,'EffectArray[#0].@Reference',`Unit,Ship,${path}`);
    field('Upgrade',id,'EffectArray[#0]',value);
    if(operation)field('Upgrade',id,'EffectArray[#0].@Operation',operation);
    ref('Upgrade',id,'EffectArray[#0].@Reference','Unit','Ship');
  };
  obj('Unit','Ship'); field('Unit','Ship','LifeMax',200); field('Unit','Ship','LifeStart',200);
  const profile = { levelPerks:[{id:'HealthPerk',level:15,nameZhCN:'机械专业',links:[{catalog:'Upgrade',objectId:'Health'}]}],
    prestiges:[{id:'P2Upgrade',index:1,links:[{catalog:'Upgrade',objectId:'P2Upgrade'}]}], masteries:[] };
  db.prepare('INSERT INTO commander_profiles VALUES(?,?)').run('CommanderA',JSON.stringify(profile));
  const reader = options => createFieldInfluenceReader(db,{catalog:'Unit',objectId:'Ship',commanderId:'CommanderA'},options);
  return {db,obj,field,ref,upgrade,reader};
}

test('exact field reverse lookup excludes unrelated fields and AffectedUnit-only links', t => {
  const f=fixture(t);f.upgrade('Health');f.upgrade('Birth','LifeStart');f.upgrade('Energy','EnergyMax');
  f.obj('Upgrade','DisplayOnly');f.ref('Upgrade','DisplayOnly','AffectedUnitArray[0]','Unit','Ship');
  const r=f.reader().read({path:'LifeMax'});
  assert.equal(r.total,1);assert.equal(r.entries[0].objectId,'Health');assert.equal(r.entries[0].operand,'40');
  assert.equal(r.entries[0].nextQuery.path,'EffectArray[0].@Value');
  assert.equal(r.entries[0].conditions[0].level,15);assert.equal(r.entries[0].conditions[0].activationVerified,false);
  assert.equal(r.runtimeValue,null);assert.equal(r.coverage.complete,false);
});
test('missing operation stays unknown; zero/negative/fraction operands are preserved', t => {
  const f=fixture(t);f.upgrade('Unknown','LifeMax',0,null);f.upgrade('Negative','LifeMax',-10);f.upgrade('Multiply','LifeMax',1.2,'Multiply');
  const r=f.reader().read({path:'LifeMax'});
  assert.equal(r.entries.find(e=>e.objectId==='Unknown').operation,null);
  assert.equal(r.entries.find(e=>e.objectId==='Unknown').operand,'0');
  assert.equal(r.entries.find(e=>e.objectId==='Negative').operand,'-10');
  assert.equal(r.entries.find(e=>e.objectId==='Multiply').operand,'1.2');
});
test('templates expose concrete research/command navigation without claiming inheritance evaluation', t => {
  const f=fixture(t);f.upgrade('Template','LifeMax',10,'Add',{template:1});f.obj('Upgrade','Concrete',{parent:'Template'});
  f.obj('Abil','Lab',{cls:'CAbilResearch'});f.field('Abil','Lab','InfoArray[Research3].@Upgrade','Concrete');f.ref('Abil','Lab','InfoArray[Research3].@Upgrade','Upgrade','Concrete');
  const e=f.reader().read({path:'LifeMax'}).entries[0];
  assert.equal(e.template,true);assert.equal(e.inheritedBy.entries[0].objectId,'Concrete');
  assert.equal(e.inheritedBy.entries[0].researchEntrypoints[0].nextQuery.commandIndex,'Research3');
  assert.match(e.inheritedBy.status,/not-evaluated/);
  assert.equal(e.activation.kind,'player-research');
  assert.equal(e.activation.unitTaskRole,'reference-only');
});

function activateFixture(f, profile) {
  f.db.prepare("UPDATE meta SET value='B97579' WHERE key='sc2Build'").run();
  f.db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify(profile),'CommanderA');
}
function research(f, id, ability='Lab', cls='CAbilResearch') {
  f.obj('Abil',ability,{cls}); f.field('Abil',ability,'InfoArray[Research3].@Upgrade',id);
  f.ref('Abil',ability,'InfoArray[Research3].@Upgrade','Upgrade',id);
}

test('typed default/level/mastery grants are startup candidates, not activated totals', t => {
  const f=fixture(t);for(const id of ['Default','Health','Mastery'])f.upgrade(id);
  activateFixture(f,{panel:{defaultUpgrades:['Default']},levelPerks:[{id:'L15',level:15,links:[{catalog:'Upgrade',objectId:'Health',fieldId:'Upgrade'}]}],
    masteries:[{id:'M1',links:[{catalog:'Upgrade',objectId:'Mastery',fieldId:'Upgrade'}]}]});
  const r=f.reader().read({path:'LifeMax'});
  assert.equal(r.activationCounts['startup-automatic'],3);
  for(const e of r.entries){assert.equal(e.activation.kind,'startup-automatic');assert.equal(e.activation.activationVerified,false);assert.equal(e.activation.unitTaskRole,'startup-context');}
  assert.equal(r.entries.find(e=>e.objectId==='Health').conditions[0].level,15);
  f.db.prepare("UPDATE meta SET value='UNREVIEWED' WHERE key='sc2Build'").run();
  assert.equal(f.reader().read({path:'LifeMax'}).activationCounts.unknown,3);
});

test('reviewed navigation and UpgradeOff are not evidence of startup grants', t => {
  const f=fixture(t);f.upgrade('ResearchUnlocked');f.upgrade('DisabledAtStart');research(f,'ResearchUnlocked');
  activateFixture(f,{levelPerks:[{id:'L1',level:1,links:[
    {catalog:'Upgrade',objectId:'ResearchUnlocked',role:'reviewed-partial-mechanism'},
    {catalog:'Upgrade',objectId:'DisabledAtStart',fieldId:'UpgradeOff'}]}]});
  const es=f.reader().read({path:'LifeMax'}).entries;
  assert.equal(es.find(e=>e.objectId==='ResearchUnlocked').activation.kind,'player-research');
  assert.equal(es.find(e=>e.objectId==='DisabledAtStart').activation.kind,'unknown');
});

test('player-researched Set is secondary reference; no automatic conflict or scope expansion', t => {
  const f=fixture(t);f.upgrade('AResearch','LifeMax',125,'Set');f.upgrade('ZStartup');research(f,'AResearch');
  activateFixture(f,{panel:{defaultUpgrades:['ZStartup']}});
  const r=f.reader().read({path:'LifeMax'}),s=f.reader().summary('LifeMax');
  assert.equal(r.entries[0].objectId,'ZStartup');
  assert.equal(r.entries[1].activation.kind,'player-research');assert.equal(r.entries[1].operation,'Set');
  assert.equal(r.entries[1].activation.unitTaskRole,'reference-only');
  assert.equal(r.taskPolicy.research,'reference-only-unless-requested');
  assert.deepEqual(s.preview.map(e=>e.objectId),['ZStartup']);assert.equal(s.researchReferenceCount,1);
  assert.equal(s.total,2);assert.equal(s.truncated,true);
  const only=f.reader().summary('LifeStart');assert.equal(only.total,0);
  assert.equal(r.entries[1].activation.exclusive,false);
  f.upgrade('OnlyResearch','LifeStart',50,'Set');research(f,'OnlyResearch','SecondLab');
  const secondary=f.reader().summary('LifeStart');assert.equal(secondary.total,1);
  assert.equal(secondary.researchReferenceCount,1);assert.deepEqual(secondary.preview,[]);
  assert.equal(secondary.truncated,true);assert.equal(secondary.nextQuery.path,'LifeStart');
});

test('both startup and research remain mixed; required-upgrade supplements are not startup claims', t => {
  const f=fixture(t);f.upgrade('Both');research(f,'Both');f.upgrade('Supplement');
  activateFixture(f,{panel:{defaultUpgrades:['Both']},prestiges:[{id:'P2',links:[
    {catalog:'Upgrade',objectId:'Supplement',role:'conditional-prestige-supplement',requiredUpgrades:['SomeResearch']}]}]});
  const r=f.reader().read({path:'LifeMax'});
  assert.equal(r.entries[0].activation.kind,'mixed');assert.equal(r.entries[0].activation.unitTaskRole,'startup-context');
  const e=r.entries.find(e=>e.objectId==='Supplement');assert.equal(e.activation.kind,'conditional-automatic');
  assert.deepEqual(e.conditions[0].requiredUpgrades,['SomeResearch']);assert.equal(e.activation.activationVerified,false);
});

test('other commander self grants do not classify local research as automatic, shared grants stay visible', t => {
  const f=fixture(t);f.upgrade('Shared');research(f,'Shared');activateFixture(f,{});
  const profile={panel:{defaultUpgrades:['Shared']}};
  f.db.prepare('INSERT INTO commander_profiles VALUES(?,?)').run('CommanderB',JSON.stringify(profile));
  assert.equal(f.reader().read({path:'LifeMax'}).entries[0].activation.kind,'player-research');
  f.db.prepare('UPDATE commander_profiles SET profile_json=? WHERE commander_id=?').run(JSON.stringify({prestiges:[{id:'P2',links:[
    {catalog:'Upgrade',objectId:'Shared',role:'secondary-prestige-upgrade',recipientScope:'commander-players'}]}]}),'CommanderB');
  assert.equal(f.reader().read({path:'LifeMax'}).entries[0].activation.kind,'mixed');
});

test('research source must be CAbilResearch and current command, not a stale or arbitrary Abil link', t => {
  const f=fixture(t);f.upgrade('One');research(f,'One','Fake','CAbilTrain');
  assert.equal(f.reader().read({path:'LifeMax'}).entries[0].activation.kind,'unknown');
  research(f,'One','Real');assert.equal(f.reader().read({path:'LifeMax'}).entries[0].activation.kind,'player-research');
  f.db.prepare("UPDATE catalog_fields SET value='Other' WHERE catalog='Abil' AND object_id='Real'").run();
  assert.equal(f.reader().read({path:'LifeMax'}).entries[0].activation.kind,'unknown');
});

test('template child grants and research are combined as candidates, not inheritance evaluation', t => {
  const f=fixture(t);f.upgrade('Template','LifeMax',1,'Add',{template:1});f.obj('Upgrade','Child',{parent:'Template'});research(f,'Child');
  activateFixture(f,{panel:{defaultUpgrades:['Child']}});
  const e=f.reader().read({path:'LifeMax'}).entries[0];assert.equal(e.activation.kind,'mixed');
  assert.equal(e.activation.evidence[0].viaUpgrade,'Child');assert.equal(e.activation.activationVerified,false);
});
test('prestige query context is preserved but is not treated as proof of activation', t => {
  const f=fixture(t);f.upgrade('P2Upgrade','LifeMax',125,'Set');
  const r=createFieldInfluenceReader(f.db,{catalog:'Unit',objectId:'Ship',commanderId:'CommanderA',prestigeUpgrade:'P2Upgrade'}).read({path:'LifeMax'});
  const e=r.entries[0];assert.equal(e.conditions[0].kind,'prestiges');assert.equal(e.activationVerified,false);
  assert.equal(e.nextQuery.prestigeUpgrade,'P2Upgrade');
});
test('new readers observe current values/retargets, not stale reverse rows or cached plans', t => {
  const f=fixture(t);f.upgrade('Health');assert.equal(f.reader().read({path:'LifeMax'}).entries[0].operand,'40');
  f.db.prepare("UPDATE catalog_fields SET value='60' WHERE object_id='Health' AND path='EffectArray[#0]'").run();
  assert.equal(f.reader().read({path:'LifeMax'}).entries[0].operand,'60');
  f.db.prepare("UPDATE catalog_fields SET value='Unit,Other,LifeMax' WHERE object_id='Health' AND path LIKE '%Reference'").run();
  assert.equal(f.reader().read({path:'LifeMax'}).total,0);
});
test('project scope comes from receipts but current operand comes from generated fields', t => {
  const f=fixture(t),op={kind:'commander.stat.set',catalog:'Unit',object:'Ship',path:'LifeMax',commanderId:'CommanderA',prestigeUpgrade:'P2Upgrade',value:240};
  const id=commanderStatIdentity(op).upgradeId;f.upgrade(id,'LifeMax',260,'Set');
  const e=f.reader({applied:[{operation:op,planId:'old-plan'}]}).read({path:'LifeMax'}).entries[0];
  assert.equal(e.operand,'260');assert.equal(e.conditions[0].prestigeUpgrade,'P2Upgrade');assert.equal(e.conditions[0].activationVerified,false);
});
test('attached vital behaviors are candidates, external buffs and scripts remain explicitly unknown', t => {
  const f=fixture(t);f.obj('Behavior','VitalBuff');f.field('Unit','Ship','BehaviorArray[0].@Link','VitalBuff');
  f.field('Behavior','VitalBuff','Modification.VitalMaxArray[Life]',50);
  f.field('Behavior','VitalBuff','Modification.VitalMaxFractionArray[Shields]',0.2);
  const r=f.reader().read({path:'LifeMax'});assert.equal(r.total,1);assert.equal(r.entries[0].kind,'attached-behavior-vital');
  assert.equal(r.entries[0].operand,'50');assert.equal(r.coverage.dynamicScripts,'not-analyzed');
  assert.equal(f.reader().read({path:'EnergyMax'}).coverage.complete,false);
});
test('explicit attachment override does not resurrect inherited behavior', t => {
  const f=fixture(t);f.obj('Behavior','Old');f.obj('Behavior','New');
  f.field('Unit','Ship','BehaviorArray[#0].@Link','Old');f.field('Unit','Ship','BehaviorArray[0].@Link','New');
  f.field('Behavior','Old','Modification.VitalMaxArray[Life]',50);f.field('Behavior','New','Modification.VitalMaxArray[Life]',10);
  const r=f.reader().read({path:'LifeMax'});assert.deepEqual(r.entries.map(e=>e.objectId),['New']);
});
test('bounded summary and nextQuery preserve path/context and page without losing candidates', t => {
  const f=fixture(t);for(let i=0;i<6;i++)f.upgrade('U'+i);
  const s=f.reader().summary('LifeMax');assert.equal(s.preview.length,2);assert.equal(s.total,6);assert.equal(s.truncated,true);
  let r=f.reader().read({path:'LifeMax',limit:2});let ids=r.entries.map(e=>e.objectId);
  while(r.nextQuery){assert.equal(r.nextQuery.path,'LifeMax');assert.equal(r.nextQuery.commanderId,'CommanderA');r=f.reader().read(r.nextQuery);ids.push(...r.entries.map(e=>e.objectId));}
  assert.equal(new Set(ids).size,6);assert.throws(()=>f.reader().read({limit:0}));
});
