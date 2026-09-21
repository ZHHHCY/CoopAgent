import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {upgradeOperandScope} from '../lib/definition-scope.mjs';

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE catalog_objects(catalog,object_id,class,parent_id);
    CREATE TABLE catalog_fields(catalog,object_id,path,value);
    CREATE TABLE object_references(source_catalog,source_object_id,field_path,target_catalog,target_object_id,confidence);
    CREATE TABLE commander_membership(commander_id,catalog,object_id);`);
  const object=(c,id,type,parent=null)=>db.prepare('INSERT INTO catalog_objects VALUES (?,?,?,?)').run(c,id,type,parent);
  const field=(c,id,p,v)=>db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run(c,id,p,v);
  const member=(c,id,owner)=>db.prepare('INSERT INTO commander_membership VALUES (?,?,?)').run(owner,c,id);
  const ref=(c,id,p)=>{field(c,id,p,'Talent');db.prepare('INSERT INTO object_references VALUES (?,?,?,?,?,?)').run(c,id,p,'Upgrade','Talent',1);};
  object('Upgrade','Talent','CUpgrade');member('Upgrade','Talent','A');
  return {db,object,field,member,ref,read:()=>upgradeOperandScope(db,'Talent','A')};
}

test('count-only conditions do not read changed operands, typed grants use instance owner rather than shared User root',t=>{
  const f=fixture(t);
  f.object('Requirement','CountTalent','CRequirementCountUpgrade');f.ref('Requirement','CountTalent','Count.@Link');
  f.member('Requirement','CountTalent','B');
  f.object('User','Talents','CUser');f.member('User','Talents','B');f.ref('User','Talents','Instances[#31].Upgrade.Upgrade');
  for(const [p,v] of Object.entries({'Id':'TalentA','User[0].Field.Id':'Commander','User[0].Type':'PlayerCommanders','User[0].Instance':'A'}))f.field('User','Talents',`Instances[31].${p}`,v);
  const s=f.read();assert.equal(s.boundedPrivate,true);assert.deepEqual(s.outsideCommanders,[]);
  assert.equal(s.consumers.find(c=>c.catalog==='Requirement').operandValueRead,false);
  assert.equal(s.consumers.find(c=>c.catalog==='User').instanceId,'TalentA');
  f.db.prepare("UPDATE catalog_fields SET value='B' WHERE path='Instances[31].User[0].Instance'").run();
  assert.equal(f.read().boundedPrivate,false);assert.deepEqual(f.read().outsideCommanders,['B']);
});

test('unknown and stale User grants cannot be proven by root membership or a different instance',t=>{
  const f=fixture(t);f.object('User','Talents','CUser');f.member('User','Talents','A');
  f.ref('User','Talents','Instances[31].Upgrade.Upgrade');
  for(const [p,v] of Object.entries({'Id':'Other','User.Field.Id':'Commander','User.Type':'PlayerCommanders','User.Instance':'A'}))f.field('User','Talents',`Instances[3].${p}`,v);
  assert.equal(f.read().boundedPrivate,false);assert.equal(f.read().unownedConsumers[0].reason,'instance-commander-link-unproven');
  f.db.prepare("UPDATE catalog_fields SET value='Retargeted' WHERE path='Instances[31].Upgrade.Upgrade'").run();
  assert.equal(f.read().boundedPrivate,false);assert.equal(f.read().unownedConsumers[0].reason,'current-reference-unresolved');
});

test('foreign research, inherited upgrades and unknown consumers still prevent private writes',t=>{
  const f=fixture(t);f.object('Abil','Research','CAbilResearch');f.ref('Abil','Research','InfoArray[Research1].@Upgrade');
  assert.equal(f.read().boundedPrivate,false);
  f.member('Abil','Research','B');assert.deepEqual(f.read().outsideCommanders,['B']);
  f.object('Upgrade','Child','CUpgrade','Talent');f.member('Upgrade','Child','C');
  assert.deepEqual(f.read().outsideCommanders,['B','C']);
  assert.equal(f.read().consumers.find(c=>c.objectId==='Child').role,'inherits-definition');
});

test('bounded results never claim proof after truncation',t=>{
  const f=fixture(t);
  for(let i=0;i<129;i++){f.object('Requirement',`Count${i}`,'CRequirementCountUpgrade');f.ref('Requirement',`Count${i}`,'Count.Link');}
  assert.equal(f.read().truncated,true);assert.equal(f.read().boundedPrivate,false);
});
