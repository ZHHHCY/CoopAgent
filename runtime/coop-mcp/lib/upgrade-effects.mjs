import {canonicalEditPath} from '../../../scripts/lib/catalog-edit-contract.mjs';
import {createResearchRouteReader} from './upgrade-activation.mjs';
import {upgradeOperandScope} from './definition-scope.mjs';
import {createFieldUsageReader} from './field-usage.mjs';
import {readUpgradeOperation} from './upgrade-operation.mjs';
const canonical=p=>String(p).replaceAll('.@','.').replace(/\[#(\d+)\]/g,'[$1]').replace(/^EffectArray(?=\.|$)/,'EffectArray[0]');
export function readUpgradeEffects(db,input,{inspect,dependencies}) {
  if(input.catalog!=='Upgrade')throw Error('upgradeEffects requires catalog=Upgrade.');
  const context={...(input.commanderId?{commanderId:input.commanderId}:{}),...(input.prestigeUpgrade?{prestigeUpgrade:input.prestigeUpgrade}:{})};
  const query=(catalog,objectId,path)=>({operation:'entity.get',...context,catalog,objectId,...(path?{path}:{})});
  const fieldCache=new Map(),indices=new WeakMap();
  const fields=(catalog,id)=>{const key=`${catalog}/${id}`;if(!fieldCache.has(key))fieldCache.set(key,db.prepare('SELECT path,value,source_file,origin_object_id,inheritance_depth FROM catalog_fields WHERE catalog=? AND object_id=?').all(catalog,id));return fieldCache.get(key);};
  const pick=(rows,p)=>{
    if(!indices.has(rows)){const map=new Map();for(const row of rows){const key=canonical(row.path),prior=map.get(key);if(!prior||(!prior.path.includes('[')&&row.path.includes('[')))map.set(key,row);}indices.set(rows,map);}
    return indices.get(rows).get(canonical(p));
  };
  const rows=fields('Upgrade',input.objectId),entries=[];
  for(const ref of rows) {
    if(!/^EffectArray(?:\[[^\]]+\])?\.Reference$/.test(canonical(ref.path)))continue;
    if(pick(rows,ref.path)!==ref)continue;
    const [catalog,objectId,...rest]=ref.value.split(','),path=rest.join(',');
    if(!catalog||!objectId||!path)continue;
    const stem=canonical(ref.path).replace(/\.Reference$/,''),operand=pick(rows,`${stem}.Value`)??pick(rows,stem),operation=pick(rows,`${stem}.Operation`);
    entries.push({reference:{catalog,objectId,path},referencePath:ref.path,referenceValue:ref.value,stem,operand,operation});
  }
  entries.sort((a,b)=>a.stem.localeCompare(b.stem,undefined,{numeric:true}));
  const filter=input.reference,matching=entries.filter(e=>!filter||(e.reference.catalog===filter.catalog&&e.reference.objectId===filter.objectId&&(!filter.path||canonical(e.reference.path)===canonical(filter.path))));
  const offset=input.offset??0,limit=input.limit??8;
  const currentEdit=p=>{const state=inspect('Upgrade',input.objectId,p),edit=state.edit;return {...edit,
    ...(edit.available?{requiredDependsOn:dependencies(edit.operation)}:{}),diagnostic:state.catalogEdit?.diagnostic};};
  const usage=createFieldUsageReader(db,{inspect,dependencies});
  const effects=matching.slice(offset,offset+limit).map(e=>{
    const p=e.operand?canonicalEditPath('CUpgrade',e.operand.path):null;
    const operationSemantics=readUpgradeOperation(db,input.objectId,e.stem,rows);
    return {reference:e.reference,referenceValue:e.referenceValue,referencePath:e.referencePath,
      operation:operationSemantics.effective.value,operationBasis:operationSemantics.effective.basis,
      operationSemantics,
      operationPath:e.operation?.path??`${e.stem}.@Operation`,source:e.operand?.source_file??null,
      edit:p?currentEdit(p):{available:false,reason:'missing-operand'},
      ...(p?{operandUsageEvidence:usage.forField('Upgrade',input.objectId,p)}:{}),
      targetUsageEvidence:usage.forField(e.reference.catalog,e.reference.objectId,e.reference.path),
      ...(p?{nextQuery:query('Upgrade',input.objectId,p)}:{}),targetQuery:query(e.reference.catalog,e.reference.objectId,e.reference.path)};
  });
  const related=db.prepare("SELECT object_id AS objectId,parent_id AS parentId,is_default AS isDefault FROM catalog_objects WHERE catalog='Upgrade' AND object_id<>? AND (parent_id=? OR object_id=(SELECT parent_id FROM catalog_objects WHERE catalog='Upgrade' AND object_id=?) OR parent_id=(SELECT parent_id FROM catalog_objects WHERE catalog='Upgrade' AND object_id=?)) ORDER BY object_id LIMIT 17").all(input.objectId,input.objectId,input.objectId,input.objectId);
  const research=createResearchRouteReader(db,{fields,pick,canonical,query});
  const object=db.prepare("SELECT is_default FROM catalog_objects WHERE catalog='Upgrade' AND object_id=?").get(input.objectId);
  return {kind:'upgrade-effects',objectId:input.objectId,context,filter:filter??null,effects,total:matching.length,totalUnfiltered:entries.length,offset,
    operandScope:upgradeOperandScope(db,input.objectId,input.commanderId),
    nextOffset:offset+effects.length<matching.length?offset+effects.length:null,
    nextQuery:offset+effects.length<matching.length?{...input,offset:offset+effects.length}:null,
    research:research.forCandidate({catalog:'Upgrade',objectId:input.objectId,template:Boolean(object?.is_default)}),
    relatedUpgrades:related.slice(0,16).map(r=>({...r,nextQuery:{...query('Upgrade',r.objectId),topic:'upgradeEffects',...(filter?{reference:filter}:{})}})),relatedTruncated:related.length>16,
    evidenceUse:{provided:['current operands with Reference/Operation','exact edit operations, expect and dependencies','actual research routes and related Upgrade records'],
      reuse:'Available edit records already supply exact current-field evidence. nextQuery on an effect is an optional refresh, not a required confirmation. Read unobserved requested levels/forms; do not re-read known operands in the unchanged context.',
      noOp:'If all requested existing upgrade operands already match the target, report no change. A no-op does not require choosing isolation or proving how a hypothetical write would propagate.',
      ...(filter&&matching.length===0?{emptyFilter:'This exact Reference filter has no matches. A Unit filter does not include its Weapon/Effect dependencies; follow that Unit’s combat links to the actual damage Effect before filtering. This is not proof that the unit receives no upgrade.'}:{})},
    boundary:'Current Upgrade operands, not applied player totals. Filter by the exact target Reference to locate entries in large arrays. Inspect actual research levels and alternate-form targets; a template is not a researched upgrade. Keep Reference/Operation and unrelated operands unchanged. Unknown activation/order remains unknown.'};
}
