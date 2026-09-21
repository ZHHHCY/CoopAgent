import {DOMParser} from '@xmldom/xmldom';
import {inspectMasteryPoint,masteryPointSelector} from '../../../scripts/lib/mastery-point-editor.mjs';

// Share the authoritative field-specific metadata proof with query callers.
export function masteryMetadataScope(db,catalog,objectId,field,commanderId) {
  let owner=null;
  if(catalog==='Commander'&&/^MasteryTalentArray\[\d+\]\.ValuePerRank$/.test(field??'')) {
    owner=db.prepare('SELECT id FROM commanders WHERE commander_object_id=?').get(objectId)?.id;
  }else if(catalog==='User'&&objectId==='MasteryUpgrades'&&masteryPointSelector(field??'')) {
    const xml=db.prepare("SELECT direct_xml FROM main.catalog_objects WHERE catalog='User' AND object_id='MasteryUpgrades'").get()?.direct_xml;
    if(xml)owner=inspectMasteryPoint(new DOMParser().parseFromString(xml,'application/xml').documentElement,null,field)?.ownerCommanderId;
  }
  if(!owner)return null;
  return {membershipIds:[owner],outsideCommanders:owner===commanderId?[]:[owner],unownedConsumers:[],consumers:[],
    boundedPrivate:owner===commanderId,
    fieldIdentity:{path:field,ownerCommanderId:owner,basis:catalog==='User'?'typed-PlayerCommanders-instance':'Commander-object-mapping'}};
}

// Field-specific static scope evidence for changing only an existing Upgrade
// operand. CountUpgrade consumers read level/count, not EffectArray.Value.
const canonical=p=>String(p).replaceAll('.@','.').replace(/\[#(\d+)\]/g,'[$1]');
export function upgradeOperandScope(db,objectId,commanderId) {
  const tables=new Set(db.prepare("SELECT name FROM main.sqlite_master WHERE type IN ('table','view')").all().map(r=>r.name));
  if(!tables.has('commander_membership')||!tables.has('object_references'))return null;
  const owners=db.prepare("SELECT DISTINCT commander_id AS id FROM commander_membership WHERE catalog='Upgrade' AND object_id=?").all(objectId).map(r=>r.id);
  const refs=db.prepare(`SELECT r.source_catalog AS catalog,r.source_object_id AS objectId,r.field_path AS fieldPath,o.class
    FROM object_references r LEFT JOIN catalog_objects o ON o.catalog=r.source_catalog AND o.object_id=r.source_object_id
    WHERE r.target_catalog='Upgrade' AND r.target_object_id=? AND r.confidence>=0.75 ORDER BY r.source_catalog,r.source_object_id,r.field_path LIMIT 129`).all(objectId);
  const children=db.prepare("SELECT catalog,object_id AS objectId,'parent' AS fieldPath,class FROM catalog_objects WHERE catalog='Upgrade' AND parent_id=? LIMIT 129").all(objectId);
  const consumers=[],unknown=[],outside=new Set(owners.filter(id=>commanderId&&id!==commanderId)),fields=new Map();
  const rows=(c,id)=>{const key=`${c}/${id}`;if(!fields.has(key))fields.set(key,new Map(db.prepare('SELECT path,value FROM catalog_fields WHERE catalog=? AND object_id=?').all(c,id).map(r=>[canonical(r.path),r.value])));return fields.get(key);};
  for(const c of [...refs.slice(0,128),...children.slice(0,128)]) {
    const p=canonical(c.fieldPath),values=rows(c.catalog,c.objectId);
    if(c.fieldPath!=='parent'&&values.get(p)!==objectId){unknown.push({...c,reason:'current-reference-unresolved'});continue;}
    if(c.class==='CRequirementCountUpgrade'&&/^Count\.Link$/.test(p)) {
      consumers.push({...c,role:'level-count-only',operandValueRead:false});continue;
    }
    let owner=null,instanceId=null;
    const prefix=c.catalog==='User'&&/^(Instances(?:\[\d+\])?)\.Upgrade\.Upgrade$/.exec(p)?.[1];
    if(prefix) {
      instanceId=values.get(`${prefix}.Id`);
      const links=[...values].filter(([k,v])=>k.startsWith(`${prefix}.User`)&&k.endsWith('.Field.Id')&&v==='Commander');
      if(links.length===1){const stem=links[0][0].slice(0,-'.Field.Id'.length);if(values.get(`${stem}.Type`)==='PlayerCommanders')owner=values.get(`${stem}.Instance`);}
    }
    if(owner&&instanceId) {
      if(!owners.includes(owner))owners.push(owner);if(commanderId&&owner!==commanderId)outside.add(owner);
      consumers.push({...c,role:'typed-commander-grant',ownerCommanderId:owner,instanceId});continue;
    }
    if(c.catalog==='User') {
      const consumer={...c,role:'unresolved-user-grant',reason:'instance-commander-link-unproven'};
      consumers.push(consumer);unknown.push(consumer);continue;
    }
    const memberships=db.prepare('SELECT DISTINCT commander_id AS id FROM commander_membership WHERE catalog=? AND object_id=?').all(c.catalog,c.objectId).map(r=>r.id);
    for(const id of memberships)if(commanderId&&id!==commanderId)outside.add(id);
    const consumer={...c,role:c.fieldPath==='parent'?'inherits-definition':'catalog-consumer',commanderIds:memberships};
    consumers.push(consumer);if(!memberships.length)unknown.push(consumer);
  }
  const truncated=refs.length>128||children.length>128;
  return {kind:'upgrade-operand-scope',membershipIds:[...new Set(owners)].sort(),outsideCommanders:[...outside].sort(),
    unownedConsumers:unknown,consumers,truncated,
    boundedPrivate:!!commanderId&&owners.includes(commanderId)&&outside.size===0&&unknown.length===0&&!truncated,
    boundary:'Static evidence for changing EffectArray.Value only, preserving Reference/Operation and upgrade levels. Count-only consumers cannot observe this operand change. Unknown grants/scripts remain unproven; this is not runtime exclusivity or authorization for a different field.'};
}
