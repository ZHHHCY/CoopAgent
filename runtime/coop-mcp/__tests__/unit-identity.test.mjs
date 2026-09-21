import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createUnitIdentityReader} from '../lib/unit-identity.mjs';
test('identity follows current cocoon production to a commander source, retaining restrictions and rejecting stale references',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE catalog_fields(catalog,object_id,path,value,source_file); CREATE TABLE object_references(source_catalog,source_object_id,field_path,target_catalog,target_object_id); CREATE TABLE catalog_objects(catalog,object_id,class); CREATE TABLE commander_membership(commander_id,catalog,object_id,depth,evidence);');
    const field=(c,id,p,v)=>db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?)').run(c,id,p,v,'test');
    const ref=(c,id,p,tc,ti)=>db.prepare('INSERT INTO object_references VALUES (?,?,?,?,?)').run(c,id,p,tc,ti);
    for(const [ability,result,producer] of [['Hatch','ActualQueen','Cocoon'],['Train','Cocoon','OwnStarport']]) {
      db.prepare('INSERT INTO catalog_objects VALUES (?,?,?)').run('Abil',ability,'CAbilTrain');
      field('Abil',ability,'InfoArray[Train1].Unit',result);ref('Abil',ability,'InfoArray[Train1].Unit','Unit',result);
      field('Unit',producer,'AbilArray[0].@Link',ability);ref('Unit',producer,'AbilArray[0].@Link','Abil',ability);
    }
    db.prepare('INSERT INTO commander_membership VALUES (?,?,?,?,?)').run('C','Unit','OwnStarport',0,'typed-userdata:TechUnit');
    db.prepare('INSERT INTO commander_membership VALUES (?,?,?,?,?)').run('C','Unit','PreviewQueen',0,'typed-userdata:Commander.UnitArray');
    const read=id=>createUnitIdentityReader(db,{commanderId:'C'}).read(id);
    assert.equal(read('PreviewQueen').hasCommanderProductionRoute,false);
    const result=read('ActualQueen');assert.equal(result.hasCommanderProductionRoute,true);
    assert.deepEqual(result.routes[0].steps.map(s=>s.resultId),['Cocoon','ActualQueen']);
    assert.equal(createUnitIdentityReader(db,{commanderId:'Other'}).read('ActualQueen').hasCommanderProductionRoute,false);
    field('Abil','Train','InfoArray[Train1].Button.@State','Restricted');
    assert.equal(read('ActualQueen').hasCommanderProductionRoute,false);
    assert.equal(read('ActualQueen').routes.some(r=>r.restrictedInCatalog),true);
    db.prepare("UPDATE catalog_fields SET value='OtherUnit' WHERE catalog='Abil' AND object_id='Hatch' AND path='InfoArray[Train1].Unit'").run();
    assert.deepEqual(read('ActualQueen').routes,[]);
  }finally{db.close();}
});
