import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fieldTemplate, describeField, buildFieldVocabulary, readFieldVocabulary, readObjectFieldGuide, fieldVocabularyStatus } from '../lib/field-vocabulary.mjs';
import { readObjectParameters } from '../lib/object-parameters.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES ('sc2Build','BSYNTH');
    CREATE TABLE catalog_objects(catalog TEXT,object_id TEXT,class TEXT);
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT,source_file TEXT,origin_object_id TEXT,inheritance_depth INTEGER);`);
  const add=(catalog,id,cls,fields={})=>{
    db.prepare('INSERT INTO catalog_objects VALUES (?,?,?)').run(catalog,id,cls);
    for(const [path,value] of Object.entries(fields))db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?,?,?,?)').run(catalog,id,path,String(value),'synthetic.xml',id,0);
  };
  add('Unit','SyntheticA','CUnit',{LifeMax:83,'CostResource[Minerals]':7,'CostResource[Vespene]':13,
    'AbilArray[#0].@Link':'SyntheticAbility','CardLayouts.LayoutButtons[#0].@AbilCmd':'SyntheticAbility,Execute',Mystery:999});
  add('Abil','SyntheticAbility','CAbilEffectTarget',{Effect:'SyntheticDamage','CmdButtonArray[Execute].Requirements':'MissingCondition'});
  add('Effect','SyntheticDamage','CEffectDamage',{Amount:37});
  add('Effect','SyntheticOther','CEffectOther',{Amount:41});
  add('Behavior','SyntheticBuff','CBehaviorBuff',{RemoveValidatorArray:'SyntheticValidator'});
  add('Validator','SyntheticValidator','CValidatorUnitCompareVital',{Value:0});
  add('Upgrade','SyntheticUpgrade','CUpgrade',{'EffectArray[0].@Reference':'Unit,SyntheticA,LifeMax','EffectArray[0].@Value':5,
    'EffectArray[1].@Reference':'Unit,SyntheticA,MissingField','EffectArray[2].@Reference':'Unit,MissingUnit,LifeMax'});
  return {db,add};
}
function withFixture(fn){const f=fixture();try{return fn(f);}finally{f.db.close();}}

test('upgrade operand context is shared across fields/parameters and never claims a fixed final bonus',()=>withFixture(({db,add})=>{
  add('Upgrade','SyntheticLevels','CUpgrade',{MaxLevel:5,'EffectArray[0].@Reference':'Unit,SyntheticA,LifeMax','EffectArray[0].@Value':2});
  buildFieldVocabulary(db);
  const q={catalog:'Upgrade',objectId:'SyntheticLevels',commanderId:'SyntheticCommander',prestigeUpgrade:'SyntheticPrestige'};
  const parameters=readObjectParameters(db,q),fields=readObjectFieldGuide(db,{...q,limit:100});
  assert.deepEqual(parameters.upgradeContext,fields.upgradeContext);
  assert.equal(parameters.upgradeContext.maxLevel.baselineValue,'5');
  assert.equal(parameters.upgradeContext.maxLevel.nextQuery.prestigeUpgrade,'SyntheticPrestige');
  assert.equal(parameters.upgradeContext.maxLevel.source.file,'synthetic.xml');
  assert.equal(parameters.upgradeContext.currentLevel,null);
  assert.equal(parameters.upgradeContext.composedValue,null);
  const operand=parameters.entries.find(e=>e.path==='EffectArray[0].@Value');
  assert.equal(operand.modifierContext.operation,null,'never invent default Add');
  assert.deepEqual(operand.modifierContext,fields.entries.find(e=>e.path==='EffectArray[0].@Value').modifierContext);
  assert.match(parameters.upgradeContext.conclusionBoundary,/不证明最终加成固定/);
  const page=readObjectFieldGuide(db,{...q,limit:1,offset:1});
  assert.deepEqual(page.upgradeContext,parameters.upgradeContext,'level context cannot disappear with pagination');
}));

test('shared modifier context retains mixed numeric index aliases without inventing absent defaults',()=>withFixture(({db,add})=>{
  add('Upgrade','SyntheticAliases','CUpgrade',{'EffectArray[0].@Value':2,'EffectArray[#0].@Reference':'Unit,SyntheticA,LifeMax','EffectArray[#0].@Operation':'Multiply'});
  buildFieldVocabulary(db);
  const r=readObjectParameters(db,{catalog:'Upgrade',objectId:'SyntheticAliases'});
  const operand=r.entries.find(e=>e.path==='EffectArray[0].@Value');
  assert.equal(operand.modifierContext.reference,'Unit,SyntheticA,LifeMax');
  assert.equal(operand.modifierContext.operation,'Multiply');
  assert.equal(r.upgradeContext.maxLevel,null);
}));

test('object parameter summary lists local known numeric fields and does not claim remote damage or writability',()=>withFixture(({db})=>{
  buildFieldVocabulary(db);
  const root={catalog:'Unit',objectId:'SyntheticA',commanderId:'CommanderA',prestigeUpgrade:'PrestigeA',summaryOnly:true};
  const r=readObjectParameters(db,root);
  assert.equal(r.counts.onThisObject,3);assert.equal(r.writeEligibility,'not-checked');
  assert.ok(r.coverage.unknownFields>0);assert.equal(r.onThisObject.find(e=>e.path==='Mystery'),undefined);
  assert.equal(r.onThisObject[0].nextQuery.prestigeUpgrade,'PrestigeA');
  assert.ok(!r.onThisObject.some(e=>e.path==='Amount'));
  const ability=readObjectParameters(db,r.continueVia.find(e=>e.target.objectId==='SyntheticAbility').nextQuery);
  assert.equal(ability.counts.onThisObject,0);assert.equal(ability.coverage.runtimeEvaluated,false);
  const ref=ability.entries.find(e=>e.section==='continueVia');
  const damage=readObjectParameters(db,ref.nextQuery);
  assert.equal(damage.entries[0].label,'单次伤害效果数值');assert.equal(damage.entries[0].nextQuery.path,'Amount');
  assert.equal(damage.entries[0].nextQuery.prestigeUpgrade,'PrestigeA');
  assert.equal(ability.entries.find(e=>e.section==='conditions').status,'unresolved');
}));

test('parameter guide excludes display damage, preserves removal direction, and bounds cycles to one node',()=>withFixture(({db,add})=>{
  add('Weapon','SyntheticWeapon','CWeaponLegacy',{Period:0.4,Effect:'SyntheticDamage',DisplayEffect:'SyntheticOther'});
  add('Effect','SyntheticCycle','CEffectSet',{EffectArray:'SyntheticCycle'});
  buildFieldVocabulary(db);
  const w=readObjectParameters(db,{catalog:'Weapon',objectId:'SyntheticWeapon',summaryOnly:true});
  assert.equal(w.onThisObject.length,1);assert.equal(w.continueVia.length,1);
  assert.equal(w.continueVia[0].target.objectId,'SyntheticDamage');assert.equal(w.coverage.displayReferencesExcluded,1);
  const b=readObjectParameters(db,{catalog:'Behavior',objectId:'SyntheticBuff',summaryOnly:true});
  assert.equal(b.conditions[0].role,'removal-condition');assert.equal(b.continueVia.length,0);
  const cycle=readObjectParameters(db,{catalog:'Effect',objectId:'SyntheticCycle',summaryOnly:true});
  assert.equal(cycle.continueVia[0].nextQuery.objectId,'SyntheticCycle');assert.equal(cycle.coverage.scannedFields,1);
}));

test('parameter pages retain candidates and links, numeric operands keep unknown operations, text/flags are excluded',()=>withFixture(({db,add})=>{
  add('Upgrade','SyntheticText','CUpgrade',{'EffectArray[0].@Value':'UI/Name/Example'});
  add('Unit','SyntheticFlags','CUnit',{'Attributes[Mechanical]':1,LifeMax:'true'});
  buildFieldVocabulary(db);
  const input={catalog:'Unit',objectId:'SyntheticA'},all=readObjectParameters(db,{...input,limit:100}),items=[];
  let p=readObjectParameters(db,{...input,limit:1});for(;;){items.push(...p.entries);if(!p.nextQuery)break;p=readObjectParameters(db,p.nextQuery);}
  assert.deepEqual(items,all.entries);assert.throws(()=>readObjectParameters(db,{...input,offset:-1}),/pagination/);
  const upgrade=readObjectParameters(db,{catalog:'Upgrade',objectId:'SyntheticUpgrade',summaryOnly:true});
  assert.equal(upgrade.onThisObject[0].modifierContext.operation,null);
  assert.equal(upgrade.onThisObject[0].modifierContext.reference,'Unit,SyntheticA,LifeMax');
  const text=readObjectParameters(db,{catalog:'Upgrade',objectId:'SyntheticText'});assert.equal(text.counts.onThisObject,0);assert.equal(text.coverage.nonNumericParameters,1);
  assert.equal(readObjectParameters(db,{catalog:'Unit',objectId:'SyntheticFlags'}).counts.onThisObject,0);
}));

test('object parameter reads use official baseline and fail closed for old or stale dictionaries',()=>withFixture(({db})=>{
  assert.equal(readObjectParameters(db,{catalog:'Unit',objectId:'SyntheticA'}).status,'missing');
  buildFieldVocabulary(db);db.exec("CREATE TEMP TABLE catalog_fields AS SELECT * FROM main.catalog_fields; UPDATE temp.catalog_fields SET value='500';");
  const guide=readObjectParameters(db,{catalog:'Unit',objectId:'SyntheticA',summaryOnly:true});
  assert.equal(guide.onThisObject.find(e=>e.path==='LifeMax').baselineValue,'83');
  assert.equal(guide.currentProjectIncluded,false);
  db.exec("UPDATE meta SET value='BFUTURE'");assert.equal(readObjectParameters(db,{catalog:'Unit',objectId:'SyntheticA'}).status,'stale');
}));

test('oversized objects report the scan boundary with a real field continuation, not a complete empty inventory',()=>withFixture(({db,add})=>{
  add('User','LargeSynthetic','CUser',Object.fromEntries(Array.from({length:5001},(_,i)=>[`Unknown[${i}]`,1])));
  buildFieldVocabulary(db);
  const result=readObjectParameters(db,{catalog:'User',objectId:'LargeSynthetic',summaryOnly:true});
  assert.equal(result.coverage.scanComplete,false);assert.equal(result.coverage.scannedFields,5000);
  assert.equal(result.coverage.totalFields,5001);assert.equal(result.fieldsQuery.offset,5000);
  assert.equal(readObjectFieldGuide(db,result.fieldsQuery).entries.length,1);
}));

test('generic vocabulary normalizes only dictionary addresses and distinguishes classes',()=>{
  assert.equal(fieldTemplate('InfoArray[Train7].Resource[Vespene]'),'InfoArray[].Resource[]');
  assert.equal(fieldTemplate('AbilArray[#2].@Link'),'AbilArray[].Link');
  assert.equal(describeField('Unit','CUnit','LifeMax').label,'生命上限');
  assert.equal(describeField('Effect','CEffectDamage','Amount').kind,'scalar');
  assert.equal(describeField('Effect','CEffectOther','Amount').status,'unknown');
  assert.equal(describeField('Abil','CAbilOther','BaseInfo.Time').status,'unknown');
  assert.equal(describeField('Upgrade','CUpgrade','EffectArray[2].@Value').dataType,'target-dependent');
  assert.equal(describeField('Weapon','CWeapon','DisplayEffect').role,'display');
  assert.equal(describeField('Behavior','CBehaviorBuff','RemoveValidatorArray').role,'removal-condition');
});

test('inventory enumerates known and unknown fields without object IDs or game values',()=>withFixture(({db})=>{
  const stats=buildFieldVocabulary(db),rows=readFieldVocabulary(db,{limit:100});
  assert.equal(stats.templates,rows.total);assert.ok(stats.unknown>0);assert.ok(stats.documented>0);
  assert.equal(rows.entries.find(e=>e.template==='Mystery').status,'unknown');
  assert.equal(rows.entries.find(e=>e.template==='CostResource[]').observedOccurrences,2);
  assert.ok(!JSON.stringify(rows).includes('SyntheticA'));assert.ok(!JSON.stringify(rows).includes('999'));
  const pages=[];for(let offset=0;offset<rows.total;offset+=2)pages.push(...readFieldVocabulary(db,{offset,limit:2}).entries);
  assert.deepEqual(pages,rows.entries);
  assert.deepEqual(readFieldVocabulary(db,{catalog:'Effect',cls:'CEffectOther'}).entries.map(e=>e.status),['unknown']);
  assert.throws(()=>readFieldVocabulary(db,{offset:-1}),/pagination/);
}));

test('field guide keeps exact values, array keys, context, evidence and runnable typed links',()=>withFixture(({db})=>{
  buildFieldVocabulary(db);
  const input={catalog:'Unit',objectId:'SyntheticA',commanderId:'CommanderA',prestigeUpgrade:'PrestigeA',limit:100};
  const guide=readObjectFieldGuide(db,input);
  const cost=guide.entries.find(e=>e.path==='CostResource[Vespene]');
  assert.deepEqual(cost.indices,['Vespene']);assert.equal(cost.value,'13');assert.equal(cost.nextQuery.path,cost.path);
  assert.equal(cost.nextQuery.prestigeUpgrade,'PrestigeA');assert.equal(cost.source.file,'synthetic.xml');
  const link=guide.entries.find(e=>e.meaning.label==='挂载能力');
  assert.equal(link.sourcePath,'AbilArray[#0].@Link');assert.equal(link.target.nextQuery.objectId,'SyntheticAbility');
  const ability=readObjectFieldGuide(db,link.target.nextQuery);
  const effect=ability.entries.find(e=>e.path==='Effect');
  const damage=readObjectFieldGuide(db,effect.target.nextQuery);
  assert.equal(damage.entries[0].meaning.label,'单次伤害效果数值');
  assert.equal(damage.entries[0].nextQuery.prestigeUpgrade,'PrestigeA');
  assert.equal(ability.entries.find(e=>e.meaning.targetCatalog==='Requirement').target.nextQuery,undefined);
  const cmd=guide.entries.find(e=>e.meaning.dataType==='ability-command');
  assert.equal(cmd.target.command,'Execute');assert.equal(cmd.target.nextQuery.commandIndex,undefined);
  const first=readObjectFieldGuide(db,{...input,limit:1});assert.equal(first.nextQuery.offset,1);
  assert.notEqual(readObjectFieldGuide(db,first.nextQuery).entries[0].path,first.entries[0].path);
}));

test('modifier references resolve real field addresses and do not invent absent fields',()=>withFixture(({db})=>{
  buildFieldVocabulary(db);
  const g=readObjectFieldGuide(db,{catalog:'Upgrade',objectId:'SyntheticUpgrade'});
  const refs=g.entries.filter(e=>e.meaning.dataType==='catalog-field-address');
  assert.equal(refs[0].target.fieldResolved,true);assert.equal(refs[0].target.nextQuery.path,'LifeMax');
  assert.equal(refs[1].target.fieldResolved,false);assert.equal(refs[1].target.nextQuery.path,undefined);
  assert.equal(refs[2].target.exists,false);assert.equal(refs[2].target.fieldResolved,false);assert.equal(refs[2].target.nextQuery,undefined);
  const b=readObjectFieldGuide(db,{catalog:'Behavior',objectId:'SyntheticBuff'});
  assert.equal(b.entries[0].target.catalog,'Validator');assert.equal(b.entries[0].meaning.role,'removal-condition');
}));

test('source-only inventory and guide ignore engine/project overlays; missing and stale are read-only',()=>withFixture(({db})=>{
  const before=db.prepare('SELECT count(*) n FROM sqlite_master').get().n;
  assert.equal(readFieldVocabulary(db).status,'missing');assert.equal(db.prepare('SELECT count(*) n FROM sqlite_master').get().n,before);
  buildFieldVocabulary(db);const expected=readFieldVocabulary(db,{limit:100});
  db.exec(`CREATE TEMP TABLE catalog_fields AS SELECT * FROM main.catalog_fields;
    UPDATE temp.catalog_fields SET value='9999'; CREATE TEMP TABLE catalog_objects AS SELECT * FROM main.catalog_objects;
    UPDATE temp.catalog_objects SET class='WrongClass';`);
  assert.equal(readObjectFieldGuide(db,{catalog:'Effect',objectId:'SyntheticDamage'}).entries[0].value,'37');
  buildFieldVocabulary(db);assert.deepEqual(readFieldVocabulary(db,{limit:100}),expected);
  db.exec("INSERT INTO meta VALUES ('engineCacheVersion','changed')");assert.equal(fieldVocabularyStatus(db).status,'ready');
  db.exec("UPDATE meta SET value='BFUTURE' WHERE key='sc2Build'");assert.equal(readFieldVocabulary(db).status,'stale');
  assert.equal(readObjectFieldGuide(db,{catalog:'Unit',objectId:'SyntheticA'}).entries,undefined);
}));

test('a failed inventory rebuild restores the previous complete dictionary',()=>withFixture(({db})=>{
  buildFieldVocabulary(db);const before=readFieldVocabulary(db,{limit:100});
  db.exec("CREATE TRIGGER reject_dictionary BEFORE INSERT ON coop_field_vocabulary BEGIN SELECT RAISE(ABORT,'dictionary failure'); END");
  assert.throws(()=>buildFieldVocabulary(db),/dictionary failure/);
  assert.deepEqual(readFieldVocabulary(db,{limit:100}),before);
  assert.equal(fieldVocabularyStatus(db).status,'ready');
}));

test('production parameter and field views share exact slot selection, pagination and current-read addresses',()=>withFixture(({db,add})=>{
  add('Abil','SyntheticTrain','CAbilTrain',{'InfoArray[Train1].Resource[Vespene]':71,'InfoArray[Train1].@Time':12,
    'InfoArray[Train1].@Unit':'SyntheticA','InfoArray[Train2].Resource[Vespene]':999,'InfoArray[Train2].@Unit':'Missing',
    'Cost.Cooldown.TimeUse':3});
  buildFieldVocabulary(db);
  const root={catalog:'Abil',objectId:'SyntheticTrain',commandIndex:'Train1',commanderId:'A',prestigeUpgrade:'P',limit:1};
  const entries=[];let page=readObjectParameters(db,root);
  for(;;){entries.push(...page.entries);if(!page.nextQuery)break;
    assert.equal(page.nextQuery.commandIndex,'Train1');assert.equal(page.nextQuery.prestigeUpgrade,'P');
    page=readObjectParameters(db,page.nextQuery);}
  assert.ok(entries.some(e=>e.baselineValue==='71'));assert.ok(entries.some(e=>e.path==='Cost[0].Cooldown.TimeUse'));
  assert.ok(!JSON.stringify(entries).includes('Train2'));assert.ok(!JSON.stringify(entries).includes('999'));
  for(const e of entries){assert.equal(e.nextQuery.prestigeUpgrade,'P');assert.equal(e.nextQuery.commandIndex,undefined);}
  const fields=readObjectFieldGuide(db,{...root,limit:100});
  assert.ok(!fields.entries.some(e=>e.sourcePath.includes('Train2')));
  assert.throws(()=>readObjectParameters(db,{...root,commandIndex:'Train9'}),/Unknown.*commandIndex/);
}));

test('one canonical navigation action expands placeholders and ignores superseded inherited slots',()=>withFixture(({db,add})=>{
  add('Effect','SyntheticRoot','CEffectSet',{'EffectArray[#0]':'SyntheticOther','EffectArray[0]':'##id##Hit'});
  add('Effect','SyntheticRootHit','CEffectDamage',{Amount:17});
  buildFieldVocabulary(db);
  const page=readObjectParameters(db,{catalog:'Effect',objectId:'SyntheticRoot'});
  assert.equal(page.entries.length,1);assert.equal(page.entries[0].target.objectId,'SyntheticRootHit');
  assert.equal(page.entries[0].target.nextQuery,undefined);assert.equal(page.entries[0].nextQuery.topic,undefined);
  assert.equal(readObjectFieldGuide(db,{catalog:'Effect',objectId:'SyntheticRoot'}).entries.length,1);
}));

test('parameter pagination decorates only emitted entries rather than every scanned reference',()=>withFixture(({db,add})=>{
  add('Effect','SyntheticMany','CEffectSet',Object.fromEntries(Array.from({length:200},(_,i)=>[`EffectArray[${i}]`,'SyntheticDamage'])));
  buildFieldVocabulary(db);let lookups=0;
  const observed=new Proxy(db,{get(target,key){
    if(key!=='prepare')return Reflect.get(target,key)?.bind?.(target)??Reflect.get(target,key);
    return sql=>{const statement=target.prepare(sql);
      if(!sql.startsWith('SELECT class FROM main.catalog_objects'))return statement;
      return new Proxy(statement,{get(s,k){if(k==='get')return (...args)=>{lookups++;return s.get(...args);};return Reflect.get(s,k)?.bind?.(s)??Reflect.get(s,k);}});
    };
  }});
  const page=readObjectParameters(observed,{catalog:'Effect',objectId:'SyntheticMany',limit:1});
  assert.equal(page.total,200);assert.equal(page.entries.length,1);assert.equal(lookups,2,'one root plus one emitted target');
}));

test('duplicate Unit navigation uses one action without losing card commands or source evidence',()=>withFixture(({db})=>{
  buildFieldVocabulary(db);
  const card=readObjectParameters(db,{catalog:'Unit',objectId:'SyntheticA'});
  const links=card.entries.filter(e=>e.section==='continueVia');
  assert.equal(links.length,1);assert.equal(links[0].nextQuery.objectId,'SyntheticAbility');
  assert.equal(links[0].alsoVia[0].command,'Execute');
  assert.equal(links[0].alsoVia[0].source.file,'synthetic.xml');
  assert.equal(links[0].target.nextQuery,undefined);
}));

test('group navigation remains visible before paginated attributes and preserves exact production slots',()=>withFixture(({db,add})=>{
  add('Abil','SyntheticTrain','CAbilTrain',{'InfoArray[Train4].Resource[Vespene]':70});
  buildFieldVocabulary(db);
  const input={catalog:'Unit',objectId:'SyntheticA',commanderId:'A',prestigeUpgrade:'P',limit:1};
  const context={directory:{production:[{name:'Production',role:'production-command',target:{catalog:'Abil',objectId:'SyntheticTrain'},commandIndex:'Train4',
    nextQuery:{operation:'entity.get',catalog:'Abil',objectId:'SyntheticTrain',commandIndex:'Train4'}}]}};
  const card=readObjectParameters(db,input,context);
  const production=card.groups.find(g=>g.group==='production');assert.equal(production.total,1);
  const page=readObjectParameters(db,production.nextQuery,context);
  assert.equal(page.entries.length,1);assert.equal(page.entries[0].nextQuery.commandIndex,'Train4');
  assert.equal(page.entries[0].nextQuery.prestigeUpgrade,'P');assert.equal(page.entries[0].target.objectId,'SyntheticTrain');
  const attributes=readObjectParameters(db,{...input,group:'attributes'},context);
  assert.ok(attributes.entries.every(e=>e.section==='onThisObject'));
  if(attributes.nextQuery)assert.equal(attributes.nextQuery.group,'attributes');
  assert.throws(()=>readObjectParameters(db,{...input,group:'made-up'}),/Unknown.*group/);
}));

test('localized descriptions are available on zero-parameter display objects without pretending to evaluate them',()=>withFixture(({db,add})=>{
  db.exec('CREATE TABLE localized_text(locale TEXT,text_key TEXT,value TEXT)');
  add('Button','SyntheticFace','CButton',{Tooltip:'Button/Tooltip/##id##'});
  db.prepare('INSERT INTO localized_text VALUES (?,?,?)').run('zhCN','Button/Tooltip/SyntheticFace','展示文字 <d ref="Effect,SyntheticDamage,Amount"/>');
  buildFieldVocabulary(db);
  const card=readObjectParameters(db,{catalog:'Button',objectId:'SyntheticFace'});
  assert.equal(card.entries.length,0);assert.equal(card.presentation[0].basis,'localized-display-text');
  assert.match(card.presentation[0].text,/<d ref=/);assert.equal(card.presentation[0].textKey,'Button/Tooltip/SyntheticFace');
  assert.equal(card.presentation[0].dynamicReferences[0].target.nextQuery.path,'Amount');
  assert.equal(card.currentProjectIncluded,false);
}));

test('research command presentation follows a unique zero-index display reference to the gameplay field',()=>withFixture(({db,add})=>{
  db.exec('CREATE TABLE localized_text(locale TEXT,text_key TEXT,value TEXT)');
  add('Abil','SyntheticResearch','CAbilResearch',{
    'InfoArray[Research6].@Upgrade':'SyntheticUpgrade',
    'InfoArray[Research6].Button.@DefaultButtonFace':'SyntheticAdaptivePlating',
  });
  add('Button','SyntheticAdaptivePlating','CButton',{Tooltip:'Button/Tooltip/##id##'});
  add('Behavior','SyntheticArmor','CBehaviorBuff',{'Modification.LifeArmorBonus':6});
  db.prepare('INSERT INTO localized_text VALUES (?,?,?)').run('zhCN','Button/Tooltip/SyntheticAdaptivePlating',
    '生命值低于一半时获得<d ref="Behavior,SyntheticArmor,Modification[0].LifeArmorBonus"/>点护甲。');
  buildFieldVocabulary(db);
  const input={catalog:'Abil',objectId:'SyntheticResearch',commandIndex:'Research6',commanderId:'Abathur',prestigeUpgrade:'AbathurP1'};
  const command=readObjectParameters(db,input);
  const button=command.entries.find(entry=>entry.role==='research-presentation');
  assert.equal(button.nextQuery.objectId,'SyntheticAdaptivePlating');
  assert.equal(button.nextQuery.prestigeUpgrade,'AbathurP1');
  assert.equal(button.target.presentation[0].dynamicReferences[0].target.nextQuery.path,'Modification.LifeArmorBonus');
  const presentation=readObjectParameters(db,button.nextQuery).presentation[0];
  const ref=presentation.dynamicReferences[0];
  assert.equal(ref.target.fieldResolved,true);
  assert.equal(ref.target.nextQuery.path,'Modification.LifeArmorBonus');
  assert.equal(ref.target.nextQuery.commanderId,'Abathur');
  const armor=readObjectParameters(db,{catalog:'Behavior',objectId:'SyntheticArmor'});
  assert.equal(armor.entries.find(entry=>entry.path==='Modification.LifeArmorBonus').label,'生命护甲加成');
}));
