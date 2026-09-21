import {DOMParser} from '@xmldom/xmldom';
import {masteryPointPath} from '../../../scripts/lib/mastery-point-editor.mjs';
import {upgradeOperandScope,masteryMetadataScope} from './definition-scope.mjs';
import {createFieldUsageReader} from './field-usage.mjs';
import {readUpgradeOperation} from './upgrade-operation.mjs';
const children=n=>Array.from(n?.childNodes??[]).filter(x=>x.nodeType===1);
const canonical=p=>p.replaceAll('.@','.').replace(/\[#(\d+)\]/g,'[$1]');

// One related evidence view, using the same current snapshot/edit contract.
// Nothing here chooses a coefficient, isolation strategy or user requirement.
export function readMasteryEvidence(db,input,{entry,inspect,dependencies}) {
  if(!entry||entry.kind!=='masteries'||input.catalog!=='Upgrade')throw Error('mastery topic requires an Upgrade linked to the selected commander mastery.');
  const context={commanderId:input.commanderId,...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{})};
  const query=(catalog,objectId,path)=>({operation:'entity.get',...context,catalog,objectId,...(path?{path}:{})});
  const fields=(catalog,id)=>db.prepare('SELECT path,value,source_file FROM catalog_fields WHERE catalog=? AND object_id=? ORDER BY path').all(catalog,id);
  const pick=(rows,p)=>rows.find(r=>canonical(r.path)===canonical(p));
  const edits=(catalog,id,path)=>{
    const state=inspect(catalog,id,path),edit=state.edit;
    return {available:edit.available,operation:edit.operation,...(edit.available?{expect:edit.expect,requiredDependsOn:dependencies(edit.operation)}:{}),
      ...(!edit.available?{reason:edit.reason,diagnostic:state.catalogEdit?.diagnostic}:{}),
      value:state.coreCatalog?.value??null,source:state.coreCatalog?.sourceFile??null};
  };
  const rows=fields('Upgrade',input.objectId),records=new Map();
  const usage=createFieldUsageReader(db,{inspect,dependencies});
  const mechanism=usage.forMastery(input.objectId);
  for(const row of rows) {
    const match=/^EffectArray(?:\[#?(\d+)\])?(?:\.@?(Reference|Operation|Value))?$/.exec(row.path);
    if(!match)continue;
    const index=Number(match[1]??0);if(!records.has(index))records.set(index,{index});
    records.get(index)[match[2]??'Value']=row.value;
  }
  const all=[...records.values()].sort((a,b)=>a.index-b.index),offset=input.offset??0,limit=input.limit??15;
  const effects=all.slice(offset,offset+limit).map(item=>{
    const address=`EffectArray[${item.index}].@Value`,parts=(item.Reference??'').split(','),[catalog,objectId]=parts,path=parts.slice(2).join(',');
    let target=null;
    if(catalog&&objectId&&path) {
      try {const state=inspect(catalog,objectId,path);target={catalog,objectId,path,catalogValue:state.coreCatalog?.value??null,
        scopedValue:state.commanderPatch?.value??state.coreCatalog?.value??null,
        ...(state.readDiagnostic?{readDiagnostic:state.readDiagnostic}:{}),nextQuery:query(catalog,objectId,path)};}
      catch(error){target={catalog,objectId,path,unresolved:error.message,nextQuery:query(catalog,objectId,path)};}
    }
    const operationSemantics=readUpgradeOperation(db,input.objectId,`EffectArray[${item.index}]`,rows);
    return {index:item.index,reference:item.Reference??null,operation:operationSemantics.effective.value,
      operationBasis:operationSemantics.effective.basis,operationSemantics,
      edit:edits('Upgrade',input.objectId,address),target,nextQuery:query('Upgrade',input.objectId,address)};
  });
  const object=db.prepare('SELECT direct_xml FROM catalog_objects WHERE catalog=? AND object_id=?');
  const document=(catalog,id)=>{const source=object.get(catalog,id)?.direct_xml;return source?new DOMParser().parseFromString(source,'application/xml').documentElement:null;};
  // Position/identity comes from the fixed baseline; current sparse XML is not
  // a complete instance list. Current values still come from inspect().
  const baseUser=db.prepare("SELECT direct_xml FROM main.catalog_objects WHERE catalog='User' AND object_id='MasteryUpgrades'").get()?.direct_xml;
  const instances=children(baseUser?new DOMParser().parseFromString(baseUser,'application/xml').documentElement:null).filter(n=>n.tagName==='Instances');
  const ordinal=instances.findIndex(n=>n.getAttribute('Id')===entry.id),panel=[];
  if(ordinal>=0) {
    const instance=instances[ordinal],fixed=children(instance).filter(n=>n.tagName==='Fixed');
    for(const [i,node] of fixed.entries())if(children(node).some(n=>n.tagName==='Field'&&n.getAttribute('Id')==='PointIncrement')) {
      const path=masteryPointPath(instance.getAttribute('index')||ordinal,entry.id);
      const edit=edits('User','MasteryUpgrades',path);
      panel.push({role:'panel-per-point-value',fieldId:'PointIncrement',instanceId:entry.id,
        currentValue:edit.value,edit,definitionScope:masteryMetadataScope(db,'User','MasteryUpgrades',path,input.commanderId),nextQuery:query('User','MasteryUpgrades',path),
        note:'The explicit position and Id must both match the baseline; the executor preserves them in the sparse override. Only a single PointIncrement at Fixed index 0 is engine-verified. This value is independent of gameplay operands and Tooltip display effects.'});
    }
  }
  const text=db.prepare("SELECT locale,text_key AS key,value,source_file AS source FROM localized_text WHERE text_key=? AND lower(locale) IN ('zhcn','enus') ORDER BY locale");
  const commander=db.prepare('SELECT commander_object_id AS id FROM commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)').get(input.commanderId,input.commanderId);
  const commanderMetadata=[];
  if(commander?.id) {
    const commanderFields=fields('Commander',commander.id);
    for(const row of commanderFields) {
      const match=/^(MasteryTalentArray(?:\[#?\d+\])?)\.@?Talent$/.exec(row.path);
      if(!match||row.value!==input.objectId)continue;
      for(const name of ['ValuePerRank','MaxRank','Type']) {
        const field=pick(commanderFields,`${match[1]}.${name}`)??pick(commanderFields,`${match[1]}.@${name}`);
        if(!field)continue;
        commanderMetadata.push({role:`commander-mastery-${name}`,catalog:'Commander',objectId:commander.id,path:field.path,
          edit:edits('Commander',commander.id,field.path),definitionScope:masteryMetadataScope(db,'Commander',commander.id,canonical(field.path),input.commanderId),nextQuery:query('Commander',commander.id,field.path)});
      }
    }
  }
  const presentation=[];
  for(const suffix of ['Name','ValueFormat','ValueSuffix'])presentation.push(...text.all(`UserData/MasteryUpgrades/${entry.id}_${suffix}`).map(t=>({...t,role:`mastery-panel-${suffix}`})));
  // Match actual dynamic references, never infer a display source from an ID.
  const refs=all.map(e=>e.Reference).filter(Boolean),localized=new Map();
  let tooltipTruncated=false;
  for(const reference of refs) {
    const matches=db.prepare("SELECT locale,text_key AS key,value,source_file AS source FROM localized_text WHERE lower(locale) IN ('zhcn','enus') AND instr(lower(value),lower(?))>0 ORDER BY locale,text_key LIMIT 33").all(`ref="${reference}"`);
    tooltipTruncated ||= matches.length>32;
    for(const row of matches.slice(0,32)) {
    const key=`${row.locale}/${row.key}`;
    if(!localized.has(key))localized.set(key,{...row,role:'dynamic-tooltip',references:[]});
    localized.get(key).references.push(reference);
    }
  }
  const consumers=db.prepare('SELECT source_catalog AS catalog,source_object_id AS objectId,field_path AS path FROM object_references WHERE target_catalog=? AND target_object_id=? ORDER BY source_catalog,source_object_id,field_path LIMIT 33').all('Upgrade',input.objectId);
  for(const effect of effects) {
    const [catalog,objectId,...pathParts]=String(effect.reference??'').split(',');
    effect.operandUsageEvidence=usage.forField('Upgrade',input.objectId,`EffectArray[${effect.index}].@Value`);
    effect.targetUsageEvidence=usage.forField(catalog,objectId,pathParts.join(','),{
      display:Boolean(mechanism?.official)&&input.objectId==='MasteryRaynorResearchCost'
        &&effect.reference==='Effect,MasteryRaynorResearchCostDisplayDummy,Amount'});
  }
  return {kind:'mastery-evidence',entryId:entry.id,upgradeId:input.objectId,context,
    operandScope:upgradeOperandScope(db,input.objectId,input.commanderId),
    effects,total:all.length,offset,nextOffset:offset+effects.length<all.length?offset+effects.length:null,
    nextQuery:offset+effects.length<all.length?{...input,offset:offset+effects.length}:null,
    pointLimit:{...edits('Upgrade',input.objectId,'MaxLevel'),nextQuery:query('Upgrade',input.objectId,'MaxLevel')},
    panel,commanderMetadata,presentation:[...presentation,...[...localized.values()].slice(0,12)],presentationTruncated:tooltipTruncated||localized.size>12,
    consumers:consumers.slice(0,32).map(c=>({...c,nextQuery:query(c.catalog,c.objectId,c.path)})),consumersTruncated:consumers.length>32,
    ...(mechanism?{mechanism}:{}),
    unresolved:[...(panel.length?[]:['No PointIncrement record was resolved.']),...panel.filter(p=>!p.edit.available).map(p=>`${p.role}: ${p.edit.reason}`)],
    evidenceUse:{provided:['current per-point operands with Reference/Operation','executable edit operations, expect and dependencies','point limits and separate panel metadata'],
      reuse:'Available edit records are the exact current-field evidence. Reuse them without another exact-field read in the unchanged project/context. nextQuery is for refresh after a change or resolving a specific missing fact.',
      decision:'Once the requested rate, affected operands and scope are established, proceed to the change. Preserve MaxRank/Type when changing only the per-point rate. Unknown rendered UI or runtime activation is a verification boundary, not a requirement to audit the executor before a source edit.',
      transaction:'One direct-private transaction can include the proven private Upgrade operands and metadata definitions for the same commander. isolation.owner identifies the main definition, not a restriction that every operation must target that object. Each operation is independently checked; use the returned per-field definitionScope and operandScope, and retain all expect/dependencies.'},
    boundary:'Gameplay operands, dynamic Tooltip sources and panel metadata are separate requirements. A requested UI update cannot be declared complete solely by editing a display dummy. Preserve Reference/Operation, point limits and unrelated mastery effects. Values are current source evidence; activation, point allocation and rendered UI are not runtime-verified.'};
}
