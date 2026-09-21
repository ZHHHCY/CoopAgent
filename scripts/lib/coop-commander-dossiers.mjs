// Independent profile roots, not an inferred closure of Unit modifiers.
// All generated records remain local; no extracted profile data ships here.
import { createProfileRuleResolver } from './coop-profile-rules.mjs';
export const COMMANDER_SECTIONS = ['units','buildings','forms','levelPerks','prestiges','masteries',
  'panelAbilities','panelTraits','panelCaster','defaultUpgrades','research'];
const canon = p => p.replaceAll('.@','.').replaceAll('[#','[');

export function buildCommanderDirectories(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coop_semantic_commanders(commander_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    DELETE FROM coop_semantic_commanders;`);
  const objects=db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?');
  const fields=db.prepare('SELECT path,value FROM main.catalog_fields WHERE catalog=? AND object_id=? ORDER BY path');
  const roots=new Map(), records=[];
  const profileRules=createProfileRuleResolver(db);
  for(const row of db.prepare('SELECT commander_id,profile_json FROM main.commander_profiles ORDER BY commander_id').all()) {
    const commanderId=row.commander_id,p=profileRules.enrich(commanderId,JSON.parse(row.profile_json));
    const query=(catalog,objectId,extra={})=>({operation:'entity.get',commanderId,catalog,objectId,...extra});
    const sections=Object.fromEntries(COMMANDER_SECTIONS.map(k=>[k,[]]));
    const link=(ref)=> {
      const {catalog,objectId}=ref, exists=Boolean(objects.get(catalog,objectId));
      if(exists) roots.set(`${catalog}/${objectId}`,{catalog,objectId});
      // A profile command number is NOT a Catalog InfoArray key. Preserve it
      // as evidence; only attach commandIndex for an observed exact key.
      const slot=ref.commandIndex;
      const exact= catalog==='Abil' && typeof slot==='string' && /^[A-Za-z0-9_]+$/.test(slot)
        && fields.all(catalog,objectId).some(f=>canon(f.path).startsWith(`InfoArray[${slot}].`));
      return {...ref,exists,...(exists?{nextQuery:query(catalog,objectId,exact?{commandIndex:slot}:{})}:{})};
    };
    const add=(section,item,refs,evidence)=> {
      const targets=[...new Map(refs.filter(r=>r.catalog && r.objectId).map(r=>[JSON.stringify(r),r])).values()].map(link);
      const entry={id:item.id ?? item.unitId ?? item.objectId ?? item.buttonId,
        ...(item.reviewedRules?{reviewedRules:item.reviewedRules}:{}),
        ...(item.mappingGaps?{mappingGaps:item.mappingGaps,mappingStatus:item.mappingStatus}:{}),
        ...(item.primaryUpgrade?{primaryUpgrade:item.primaryUpgrade,mappingStatus:item.mappingStatus,supersededLinks:item.supersededLinks}:{}),
        name:item.nameZhCN ?? item.nameEnUS ?? item.name ?? item.id ?? item.unitId ?? item.buttonId,
        ...(item.level!=null?{level:item.level}:{}),...(item.index!=null?{index:item.index}:{}),
        ...(item.category!=null?{category:item.category}:{}),evidence,targets};
      sections[section].push(entry); return entry;
    };
    for(const section of ['units','buildings']) for(const [i,item] of (p.roster?.[section] ?? []).entries())
      add(section,item,[{catalog:'Unit',objectId:item.unitId}],{profilePath:`roster.${section}[${i}]`,source:item.source});
    for(const section of ['levelPerks','prestiges','masteries']) for(const [i,item] of (p[section] ?? []).entries())
      add(section,item,item.mappingGaps?[]:item.links?.length?item.links:section==='prestiges'?[{catalog:'Upgrade',objectId:item.id}]:[],{profilePath:`${section}[${i}]`});
    for(const [i,item] of (p.panel?.abilityCommands ?? []).entries())
      add('panelAbilities',{...item,id:`${item.abilityId},${item.commandIndex ?? i}`},[{catalog:'Abil',objectId:item.abilityId,commandIndex:item.commandIndex}],{profilePath:`panel.abilityCommands[${i}]`});
    for(const [i,item] of (p.panel?.traits ?? []).entries())
      add('panelTraits',item,[{catalog:'Button',objectId:item.buttonId}],{profilePath:`panel.traits[${i}]`});
    for(const [i,id] of (p.panel?.defaultUpgrades ?? []).entries())
      add('defaultUpgrades',{id},[{catalog:'Upgrade',objectId:id}],{profilePath:`panel.defaultUpgrades[${i}]`});
    if(p.panel?.casterUnit) add('panelCaster',{id:p.panel.casterUnit},[{catalog:'Unit',objectId:p.panel.casterUnit}],{profilePath:'panel.casterUnit'});
    const units=db.prepare('SELECT record_json FROM main.coop_semantic_entities WHERE commander_id=? ORDER BY object_id').all(commanderId).map(r=>JSON.parse(r.record_json));
    const rosterIds=new Set([...sections.units,...sections.buildings,...sections.panelCaster].flatMap(e=>e.targets.map(t=>t.objectId)));
    for(const unit of units) if(!rosterIds.has(unit.objectId))
      add(unit.identity.profileSource==='explicit-morph-target'?'forms':'units',
        {id:unit.objectId,name:unit.name},[{catalog:'Unit',objectId:unit.objectId}],{source:unit.identity.profileSource});
    const abilities=new Map();
    for(const unit of units) for(const a of unit.abilities) {
      if(!abilities.has(a.objectId)) abilities.set(a.objectId,[]);
      abilities.get(a.objectId).push({unitId:unit.objectId,attachment:a.attachment});
    }
    for(const e of Object.values(sections).flat()) for(const t of e.targets) if(t.catalog==='Abil') {
      if(!abilities.has(t.objectId)) abilities.set(t.objectId,[]);
      abilities.get(t.objectId).push(e.evidence);
    }
    for(const [id,evidence] of [...abilities].sort(([a],[b])=>a.localeCompare(b))) {
      if(objects.get('Abil',id)?.class!=='CAbilResearch') continue;
      const fs=fields.all('Abil',id), explicit=new Set(fs.filter(f=>/\[\d+\]/.test(f.path)).map(f=>canon(f.path)));
      for(const f of fs.filter(f=>!f.path.includes('[#') || !explicit.has(canon(f.path)))) {
        const m=canon(f.path).match(/^InfoArray\[([^\]]+)\]\.Upgrade(?:\[[^\]]+\])?$/);
        if(!m || !f.value) continue;
        add('research',{id:`${id},${m[1]},${f.value}`,name:f.value},[
          {catalog:'Abil',objectId:id,commandIndex:m[1]}, {catalog:'Upgrade',objectId:f.value}],
        {field:{catalog:'Abil',objectId:id,path:f.path},associations:evidence});
      }
    }
    records.push({commanderId,sections});
  }
  return {roots:[...roots.values()],records};
}

export function saveCommanderDirectories(db,records) {
  const detail=db.prepare('SELECT record_json FROM main.coop_semantic_details WHERE catalog=? AND object_id=?');
  const unit=db.prepare('SELECT record_json FROM main.coop_semantic_entities WHERE commander_id=? AND object_id=?');
  const mods=db.prepare('SELECT record_json FROM main.coop_semantic_modifiers WHERE upgrade_id=?');
  const insert=db.prepare('INSERT INTO coop_semantic_commanders VALUES (?,?)');
  const totals={};
  for(const r of records) {
    const counts={};
    for(const [section,entries] of Object.entries(r.sections)) {
      const summary={total:entries.length,resolved:0,partial:0,unresolved:0,allEffectTargetsIndexed:0};
      for(const e of entries) {
        for(const t of e.targets) {
          const raw=t.catalog==='Unit'?unit.get(r.commanderId,t.objectId):detail.get(t.catalog,t.objectId);
          const data=raw?JSON.parse(raw.record_json):null;
          t.detailIndexed=Boolean(data);
          t.gaps=!t.exists?['missing-target']:!data?['no-prebuilt-detail']:[];
          if(data?.identity?.status==='display-object-unresolved') t.gaps.push('display-object-unresolved');
          if(data?.unresolved?.length) t.gaps.push(...new Set(data.unresolved.map(u=>u.reason)));
          if(t.catalog==='Upgrade' && t.exists) {
            const parameters=mods.all(t.objectId).map(m=>JSON.parse(m.record_json));
            if(!parameters.length) t.gaps.push('no-catalog-effect-parameters; may be activation/script-only');
            if(parameters.some(m=>!m.targetExists || !m.parameter || m.operand===null)) t.gaps.push('unresolved-modifier-parameter-or-target');
            if(parameters.some(m=>m.operation===null)) t.gaps.push('operation-default-unverified');
          }
        }
        const effects=e.targets.filter(t=>!['Button','Talent'].includes(t.catalog));
        const indexed=effects.filter(t=>t.detailIndexed);
        e.coverage={status:indexed.length?'partial':'unresolved',runtimeEvaluated:false,
          navigation:effects.length && effects.every(t=>t.exists)?'resolved':effects.some(t=>t.exists)?'partial':'unresolved',
          allEffectTargetsIndexed:Boolean(effects.length && effects.every(t=>t.detailIndexed)),
          gaps:[...(e.mappingGaps ?? []),...new Set(e.targets.flatMap(t=>t.gaps)),...(!effects.length?['no-explicit-effect-target']:[]),
            'activation-and-runtime-composition-not-evaluated']};
        summary[e.coverage.status]++;
        if(e.coverage.allEffectTargetsIndexed) summary.allEffectTargetsIndexed++;
      }
      counts[section]=summary;
      totals[section] ??= {total:0,resolved:0,partial:0,unresolved:0,allEffectTargetsIndexed:0};
      for(const k of Object.keys(summary)) totals[section][k]+=summary[k];
    }
    r.coverage={status:'partial',runtimeEvaluated:false,counts,
      inventoryBasis:'All source profile entries plus indexed forms and explicit research commands on associated abilities; not all runtime entities/mechanisms.',
      gaps:['Profile roster completeness is not verified against runtime spawns or scripts.',
        'Research associations do not prove availability; unsupported/non-Catalog research is not enumerated.',
        'Galaxy, initialization, defaults, temporary buffs and modifier combinations remain unevaluated.']};
    insert.run(r.commanderId,JSON.stringify(r));
  }
  return {commanders:records.length,commanderCoverage:totals};
}

export function readCommanderDirectory(db,input) {
  const row=db.prepare('SELECT record_json FROM main.coop_semantic_commanders WHERE commander_id=?').get(input.commanderId);
  if(!row) return {status:'not-indexed'};
  const r=JSON.parse(row.record_json), topic=input.topic ?? 'overview',offset=input.offset ?? 0,limit=input.limit ?? 30;
  if(!Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>100) throw Error('Invalid commander directory pagination.');
  if(topic!=='overview' && !COMMANDER_SECTIONS.includes(topic)) throw Error('Unknown commander directory topic.');
  const commander=db.prepare('SELECT commander_object_id FROM main.commanders WHERE id=?').get(input.commanderId);
  const nextQuery=section=>({operation:'entity.get',commanderId:r.commanderId,catalog:'Commander',objectId:commander.commander_object_id,topic:section});
  if(input.entryId) return {status:'partial',kind:'commander-entry',entries:Object.entries(r.sections).flatMap(([section,es])=>es.filter(e=>e.id?.toLowerCase()===input.entryId.toLowerCase()).map(e=>({section,...e})))};
  return {status:'partial',kind:'commander-directory',commanderId:r.commanderId,coverage:r.coverage,
    ...(topic==='overview'?{sections:Object.entries(r.coverage.counts).map(([section,counts])=>({section,...counts,nextQuery:nextQuery(section)}))}:
      {topic,total:r.sections[topic].length,offset,nextOffset:offset+limit<r.sections[topic].length?offset+limit:null,
        ...(offset+limit<r.sections[topic].length?{nextQuery:{...nextQuery(topic),offset:offset+limit,limit}}:{}),entries:r.sections[topic].slice(offset,offset+limit)})};
}
