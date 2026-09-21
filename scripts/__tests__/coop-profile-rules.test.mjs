import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createProfileRuleResolver, prestigeActivationId } from '../lib/coop-profile-rules.mjs';
import { applyReviewedLinks } from '../lib/coop-reviewed-links.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES ('sc2Build','BSYNTH');
    CREATE TABLE catalog_objects(catalog TEXT,object_id TEXT,class TEXT,direct_xml TEXT,source_file TEXT);
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT,source_file TEXT);`);
  const add=(catalog,id,xml='',cls='CUpgrade')=>db.prepare('INSERT INTO catalog_objects VALUES (?,?,?,?,?)').run(catalog,id,cls,xml,'synthetic.xml');
  add('Upgrade','ActualA');add('Upgrade','ActualB');add('Upgrade','SupplementA');add('Upgrade','ResearchA');
  add('Abil','DisabledA','', 'CAbilEffectInstant');add('Button','DisplayA','','CButton');
  add('User','PlayerCommanders',`<CUser><Instances Id="CommanderA"><User Type="PlayerPrestige" Instance="EntryA"><Field Id="Prestige"/></User></Instances>
    <Instances Id="CommanderB"><User Type="PlayerPrestige" Instance="EntryB"><Field Id="Prestige"/></User></Instances></CUser>`,'CUser');
  add('User','PlayerPrestige',`<CUser><Instances Id="EntryA"><GameLink GameLink="ActualA"><Field Id="PrimaryUpgrade"/></GameLink>
    <AbilCmd Abil="DisabledA" Cmd="0"><Field Id="DisableAbil"/></AbilCmd>
    <User Type="PlayerPrestigeUpgradeSupplements" Instance="ExtraA"><Field Id="UpgradeSupplements"/></User></Instances>
    <Instances Id="EntryB"><GameLink GameLink="ActualB"><Field Id="PrimaryUpgrade"/></GameLink></Instances></CUser>`,'CUser');
  add('User','PlayerPrestigeUpgradeSupplements',`<CUser><Instances Id="ExtraA"><GameLink GameLink="ResearchA"><Field Id="Upgrade"/></GameLink>
    <GameLink GameLink="SupplementA"><Field Id="Supplement"/></GameLink></Instances></CUser>`,'CUser');
  return {db,add,p:{prestiges:[{id:'DisplayA',index:0}],levelPerks:[]}};
}
function run(fn){const f=fixture();try{return fn(f);}finally{f.db.close();}}

test('typed prestige mapping preserves display ID and uses primary/supplement roles, not similar names',()=>run(({db,p})=>{
  const r=createProfileRuleResolver(db).enrich('CommanderA',p), e=r.prestiges[0];
  assert.equal(e.id,'DisplayA');assert.equal(e.primaryUpgrade,'ActualA');
  assert.equal(prestigeActivationId(db,e),'ActualA');
  assert.deepEqual(e.links.find(l=>l.objectId==='SupplementA').requiredUpgrades,['ResearchA']);
  assert.equal(e.links.find(l=>l.objectId==='DisabledA').role,'DisableAbil');
  assert.equal(e.links.find(l=>l.objectId==='SupplementA').activationVerified,false);
  assert.equal(e.links[0].evidence[0].instanceId,'CommanderA');
  assert.equal(p.prestiges[0].primaryUpgrade,undefined);
  assert.deepEqual(createProfileRuleResolver(db).enrich('CommanderA',r),r);
  assert.equal(createProfileRuleResolver(db).enrich('CommanderB',p).prestiges[0].primaryUpgrade,'ActualB');
}));

test('missing primary stays missing and cannot become a fake activation alias',()=>run(({db,p})=>{
  db.exec("DELETE FROM catalog_objects WHERE object_id='ActualA'");
  const e=createProfileRuleResolver(db).enrich('CommanderA',p).prestiges[0];
  assert.equal(e.primaryUpgrade,'ActualA');assert.equal(prestigeActivationId(db,e),null);
  assert.equal(e.links[0].objectId,'ActualA');
}));

test('secondary prestige grants preserve self/shared recipients and are distinct from conditional supplements',()=>run(({db,p})=>{
  const row=db.prepare("SELECT direct_xml FROM catalog_objects WHERE catalog='User' AND object_id='PlayerPrestige'").get();
  db.prepare("UPDATE catalog_objects SET direct_xml=? WHERE catalog='User' AND object_id='PlayerPrestige'").run(
    row.direct_xml.replace('<AbilCmd', '<GameLink GameLink="SelfGrant"><Field Id="SecondaryUpgradesSelf"/></GameLink><GameLink GameLink="AllyGrant"><Field Id="SecondaryUpgradesShared"/></GameLink><AbilCmd'));
  const r=createProfileRuleResolver(db).enrich('CommanderA',p),links=r.prestiges[0].links;
  assert.equal(links.find(l=>l.objectId==='SelfGrant').recipientScope,'self');
  assert.equal(links.find(l=>l.objectId==='AllyGrant').recipientScope,'commander-players');
  assert.equal(links.find(l=>l.objectId==='AllyGrant').role,'secondary-prestige-upgrade');
  assert.equal(links.find(l=>l.objectId==='AllyGrant').evidence[0].fieldId,'SecondaryUpgradesShared');
  assert.deepEqual(links.find(l=>l.objectId==='SupplementA').requiredUpgrades,['ResearchA']);
  assert.deepEqual(createProfileRuleResolver(db).enrich('CommanderA',r),r);
}));

test('ambiguous UserData slot never picks an arbitrary primary',()=>run(({db,p,add})=>{
  add('Upgrade','DisplayA');
  db.prepare("UPDATE catalog_objects SET direct_xml=? WHERE catalog='User' AND object_id='PlayerCommanders'").run(
    '<CUser><Instances Id="CommanderA"><User Type="PlayerPrestige" Instance="EntryA"><Field Id="Prestige"/></User><User Type="PlayerPrestige" Instance="EntryB"><Field Id="Prestige"/></User></Instances></CUser>');
  const e=createProfileRuleResolver(db).enrich('CommanderA',p).prestiges[0];
  assert.equal(e.primaryUpgrade,null);assert.equal(e.mappingStatus,'ambiguous-userdata');assert.equal(prestigeActivationId(db,e),null);
}));

test('rule reads use immutable main source even under temporary engine overlays',()=>run(({db,p})=>{
  const expected=createProfileRuleResolver(db).enrich('CommanderA',p);
  db.exec('CREATE TEMP TABLE catalog_objects AS SELECT * FROM main.catalog_objects');
  db.exec("UPDATE temp.catalog_objects SET direct_xml='<CUser/>'");
  assert.deepEqual(createProfileRuleResolver(db).enrich('CommanderA',p),expected);
}));

test('ArmyCategory explicit Unit link is expanded without guessing names',()=>run(({db,p,add})=>{
  add('ArmyCategory','UIArmy','','CArmyCategory');add('Unit','DifferentUnit','','CUnit');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?)').run('ArmyCategory','UIArmy','Unit','DifferentUnit','synthetic.xml');
  p.levelPerks=[{id:'UnlockA',links:[{catalog:'ArmyCategory',objectId:'UIArmy'}]}];
  const r=createProfileRuleResolver(db).enrich('CommanderA',p);
  assert.equal(r.levelPerks[0].links[1].objectId,'DifferentUnit');
  assert.equal(r.levelPerks[0].links[1].evidence.path,'Unit');
  assert.deepEqual(createProfileRuleResolver(db).enrich('CommanderA',r),r);
}));

test('reviewed rules are build/owner/object guarded, partial and idempotent',()=>run(({db,p})=>{
  p.levelPerks=[{id:'DisplayA',links:[]}];
  const rules=[{ruleId:'synthetic-rule',commanderId:'CommanderA',entryId:'DisplayA',reviewedBuild:'BSYNTH',targets:[{catalog:'Upgrade',objectId:'ActualA'}],note:'partial'}];
  const r=applyReviewedLinks(db,'CommanderA',structuredClone(p),rules);
  assert.equal(r.levelPerks[0].reviewedRules[0].status,'applied-partial');
  assert.equal(r.levelPerks[0].links[0].evidence.ruleId,'synthetic-rule');
  assert.deepEqual(applyReviewedLinks(db,'CommanderA',structuredClone(r),rules),r);
  assert.equal(applyReviewedLinks(db,'CommanderB',structuredClone(p),rules).levelPerks[0].links.length,0);
  db.exec("UPDATE meta SET value='BFUTURE'");
  const stale=applyReviewedLinks(db,'CommanderA',structuredClone(r),rules).levelPerks[0];
  assert.equal(stale.reviewedRules[0].reason,'unreviewed-build');assert.equal(stale.links.length,0);
  db.exec("UPDATE meta SET value='BSYNTH'; DELETE FROM catalog_objects WHERE object_id='ActualA'");
  assert.equal(applyReviewedLinks(db,'CommanderA',structuredClone(p),rules).levelPerks[0].reviewedRules[0].reason,'missing-target');
}));

test('reviewed research slot guard rejects changed Upgrade association',()=>run(({db,p,add})=>{
  add('Abil','ResearchAbility','','CAbilResearch');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?)').run('Abil','ResearchAbility','InfoArray[Research1].@Upgrade','ResearchA','synthetic.xml');
  p.levelPerks=[{id:'DisplayA',links:[]}];
  const rules=[{ruleId:'research-rule',commanderId:'CommanderA',entryId:'DisplayA',reviewedBuild:'BSYNTH',targets:[{catalog:'Abil',objectId:'ResearchAbility',commandIndex:'Research1',expectedUpgrade:'ResearchA'}]}];
  assert.equal(applyReviewedLinks(db,'CommanderA',structuredClone(p),rules).levelPerks[0].reviewedRules[0].status,'applied-partial');
  db.exec("UPDATE catalog_fields SET value='DifferentUpgrade'");
  assert.equal(applyReviewedLinks(db,'CommanderA',structuredClone(p),rules).levelPerks[0].reviewedRules[0].status,'guard-failed');
}));
