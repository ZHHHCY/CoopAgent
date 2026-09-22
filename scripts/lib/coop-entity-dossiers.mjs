import { projectUnitArrayFields } from '../../runtime/coop-mcp/lib/unit-arrays.mjs';
import { canonicalEditPath } from './catalog-edit-contract.mjs';
import { buildCommanderDirectories, saveCommanderDirectories } from './coop-commander-dossiers.mjs';
import { describeField, referenceTarget } from './field-vocabulary.mjs';

const canon = p => p.replaceAll('.@','.').replaceAll('[#','[');
const number = v => typeof v === 'string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) && Number.isFinite(Number(v)) ? Number(v) : null;
const key = (c,id) => `${c}/${id}`;
export const DETAIL_CATALOGS = ['Abil','Weapon','Behavior','Effect','Upgrade'];
// A legacy display selection, not another field-label dictionary.
const UNIT_ATTRIBUTES = ['LifeMax','LifeStart','LifeArmor','LifeRegenRate','ShieldsMax','ShieldsStart','ShieldArmor',
  'EnergyMax','EnergyStart','Speed','Food','CostResource[Minerals]','CostResource[Vespene]'];

export function buildCoopDossiers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS coop_semantic_details(catalog TEXT NOT NULL, object_id TEXT NOT NULL,
    record_json TEXT NOT NULL, PRIMARY KEY(catalog,object_id)); DELETE FROM coop_semantic_details;`);
  const fq=db.prepare('SELECT path,value,source_file,origin_object_id,inheritance_depth FROM main.catalog_fields WHERE catalog=? AND object_id=? ORDER BY path');
  const oq=db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?');
  const tq=db.prepare("SELECT value FROM main.localized_text WHERE text_key=? AND lower(locale) IN ('zhcn','enus') ORDER BY CASE lower(locale) WHEN 'zhcn' THEN 0 ELSE 1 END LIMIT 1");
  const cache=new Map(), details=new Map();
  const fields=(c,id)=> {
    const k=key(c,id);
    if(!cache.has(k)) {
      const raw=fq.all(c,id), explicit=new Set(raw.filter(f=>/\[\d+\]/.test(f.path)).map(f=>canon(f.path)));
      // Indexed overrides replace matching inherited ordinal properties. Do
      // not follow both the campaign and co-op effect from the same slot.
      cache.set(k,raw.filter(f=>!f.path.includes('[#') || !explicit.has(canon(f.path))));
    }
    return cache.get(k);
  };
  const name=(c,id)=> {
    const f=fields(c,id).find(f=>canon(f.path)==='Name');
    return (tq.get((f?.value ?? `${c}/Name/${id}`).replaceAll('##id##',id))?.value ?? id).split(/\s*\/\/\/\s*/)[0];
  };
  const addr=(c,id,f)=>({catalog:c,objectId:id,path:canonicalEditPath(oq.get(c,id)?.class,f.path),sourcePath:f.path,
    sourceFile:f.source_file,originObjectId:f.origin_object_id,inheritanceDepth:f.inheritance_depth});
  const links=(id,kind)=> {
    // Do NOT mix AbilArray with renamed Behavior/WeaponArray slots.
    const fs=fields('Unit',id).filter(f=>f.path.startsWith(`${kind}Array`));
    return projectUnitArrayFields(fs.map(f=>({...f,path:f.path.replace(`${kind}Array`,'AbilArray')}))).abilities.slots
      .filter(s=>typeof s.attributes.Link==='string' && s.attributes.Link)
      .map(s=>{ const ps=s.sourcePaths.map(p=>p.replace('AbilArray',`${kind}Array`));
        return fs.filter(f=>ps.includes(f.path) && f.value===s.attributes.Link).at(-1); }).filter(Boolean);
  };
  function edges(c,id) {
    const out=[];
    for(const f of fields(c,id)) {
      const meaning=describeField(c,oq.get(c,id)?.class,f.path);
      const target=referenceTarget(meaning,f.value,id);
      if(!target || !['execution','display','modifier-target'].includes(meaning.role) || target.path)continue;
      out.push({from:{catalog:c,objectId:id},target,role:meaning.role==='display'?'display-only':meaning.role,
        via:addr(c,id,f),exists:Boolean(oq.get(target.catalog,target.objectId))});
    }
    return out;
  }
  const roots=new Map();
  const addRoot=(c,id)=> {if(DETAIL_CATALOGS.includes(c) && oq.get(c,id)) roots.set(key(c,id),{catalog:c,objectId:id});};
  const commanderDirectories=buildCommanderDirectories(db);
  for(const root of commanderDirectories.roots) addRoot(root.catalog,root.objectId);
  function detail(c,id) {
    const k=key(c,id); if(details.has(k)) return details.get(k);
    const pending=[{catalog:c,objectId:id,depth:0}],seen=new Set(),nodes=[],connections=[],unresolved=[];
    while(pending.length && nodes.length<64) {
      const n=pending.shift(), nk=key(n.catalog,n.objectId); if(seen.has(nk)) continue; seen.add(nk);
      const obj=oq.get(n.catalog,n.objectId); if(!obj){unresolved.push({...n,reason:'missing-object'});continue;}
      const fs=fields(n.catalog,n.objectId), scalars=[];
      for(const f of fs) {
        const value=number(f.value), meaning=describeField(n.catalog,obj.class,f.path);
        if(value!==null && meaning.kind==='scalar') scalars.push({label:meaning.label,value,field:addr(n.catalog,n.objectId,f)});
      }
      const conditions=fs.filter(f=>['condition','removal-condition'].includes(describeField(n.catalog,obj.class,f.path).role))
        .map(f=>({value:f.value,field:addr(n.catalog,n.objectId,f)}));
      nodes.push({catalog:n.catalog,objectId:n.objectId,class:obj.class,scalars,conditions});
      for(const e of edges(n.catalog,n.objectId)) {
        if(connections.length>=256) {unresolved.push({...e.target,reason:'edge-limit'});break;}
        connections.push(e);
        if(!e.exists) unresolved.push({...e.target,reason:'missing-reference'});
        else if(e.role==='display-only') unresolved.push({...e.target,reason:'display-reference-is-not-execution'});
        else if(n.depth>=8) unresolved.push({...e.target,reason:'depth-limit'});
        else pending.push({...e.target,depth:n.depth+1});
      }
    }
    if(pending.length) unresolved.push({reason:'node-limit',remaining:pending.length});
    // Keep direct parameters of Upgrade entries; operation/activation metadata
    // lives in the existing modifier index and is added on read.
    const result={catalog:c,objectId:id,name:name(c,id),nodes,edges:connections,unresolved,
      coverage:{status:'partial',runtimeEvaluated:false,executionMultiplicityEvaluated:false,
        note:'Structural execution paths only; no DPS/total damage inference. Validators, scripts, defaults and unsupported reference shapes may add effects.'}};
    details.set(k,result); return result;
  }
  const modifierRows=db.prepare('SELECT record_json FROM main.coop_semantic_modifiers ORDER BY upgrade_id,entry_index').all().map(r=>JSON.parse(r.record_json));
  const modifierTargets=new Map();
  for(const m of modifierRows) { const k=key(m.target.catalog,m.target.objectId); if(!modifierTargets.has(k)) modifierTargets.set(k,[]); modifierTargets.get(k).push(m); }
  const update=db.prepare('UPDATE coop_semantic_entities SET record_json=? WHERE commander_id=? AND object_id=?');
  const rows=db.prepare('SELECT commander_id,object_id,record_json FROM main.coop_semantic_entities ORDER BY commander_id,object_id').all();
  for(const row of rows) {
    const r=JSON.parse(row.record_json), id=r.objectId, fs=fields('Unit',id);
    const query=(catalog,objectId,extra={})=>({operation:'entity.get',commanderId:r.commanderId,catalog,objectId,...extra});
    const entry=(c,targetId,role,via,extra={})=> {
      addRoot(c,targetId);
      return {name:name(c,targetId),target:{catalog:c,objectId:targetId},role,
        status:oq.get(c,targetId)?'linked-conditions-unresolved':'missing-target',
        ...(via?{via:{catalog:via.catalog,objectId:via.objectId,path:via.path}}:{}),
        ...(oq.get(c,targetId)?{nextQuery:query(c,targetId)}:{}),...extra};
    };
    const attributes=[];
    for(const p of UNIT_ATTRIBUTES) {
      const matches=fs.filter(f=>canon(f.path)===p), f=matches.length===1?matches[0]:null;
      if(!f) continue;
      attributes.push({label:describeField('Unit',oq.get('Unit',id)?.class,f.path).label,value:number(f.value),field:{catalog:'Unit',objectId:id,path:f.path},
        nextQuery:query('Unit',id,{path:f.path})});
    }
    const weapons=links(id,'Weapon').map(f=>entry('Weapon',f.value,'weapon',addr('Unit',id,f)));
    for(const w of weapons) {
      const wf=fields('Weapon',w.target.objectId);
      if(wf.some(f=>canon(f.path)==='Options[Hidden]' && f.value==='1')) w.role='hidden-weapon-entry';
      w.targetFilters=wf.find(f=>canon(f.path)==='TargetFilters')?.value ?? null;
    }
    const skills=[],internalAbilities=[],forms=[],passives=[];
    for(const a of r.abilities) {
      const e=entry('Abil',a.objectId,'ability',a.attachment);
      const activeCommand=a.commands.find(c=>c.command);
      const command=activeCommand?.command?.split(',')[1];
      const display=a.displayButtons.find(b=>!command || canon(b.field.path).startsWith(`CmdButtonArray[${command}]`));
      e.name=(display?.name ?? activeCommand?.name ?? e.name).split(/\s*\/\/\/\s*/)[0];
      const basic=/^CAbil(Move|Attack|Stop|Queue|Rally|Warpable|Buildable|Progress)/.test(a.class ?? '') || /^(move|attack|stop)$/i.test(a.objectId);
      if(!basic && a.commands.length) skills.push(e); else internalAbilities.push(e);
      if(/^CAbilMorph/.test(a.class ?? '')) for(const f of fields('Abil',a.objectId).filter(f=>/^InfoArray.*\.Unit(?:\[[^\]]+\])?$/.test(canon(f.path)))) {
        if(!forms.some(e=>e.target.objectId===f.value)) forms.push(entry('Unit',f.value,'form',addr('Abil',a.objectId,f),{viaAbilityId:a.objectId}));
      }
    }
    for(const b of r.behaviors) passives.push(entry('Behavior',b.objectId,'attached-behavior',b.attachment));
    // Passive command-card buttons need their own entry even without an Abil.
    for(const slot of projectUnitArrayFields(fs).commandCards.flatMap(c=>c.slots)) {
      if(String(slot.attributes.Type).toLowerCase()!=='passive' || !slot.attributes.Face) continue;
      const face=slot.attributes.Face, req=slot.attributes.Requirements;
      const c=entry('Button',face,'passive-presentation',null,{status:'implementation-unresolved'});
      if(req && oq.get('Requirement',req)) c.conditionQuery={operation:'requirement.explain',commanderId:r.commanderId,objectId:req};
      passives.push(c);
    }
    const production=r.productionKeys.map(k=>entry('Abil',k.abilityId,'production-command',null,{
      commandIndex:k.commandIndex,nextQuery:query('Abil',k.abilityId,{commandIndex:k.commandIndex})}));
    const related=new Map();
    for(const t of [{catalog:'Unit',objectId:id},...weapons.map(e=>e.target),...skills.map(e=>e.target),...passives.map(e=>e.target),...production.map(e=>e.target)]) {
      const nodes=DETAIL_CATALOGS.includes(t.catalog)?detail(t.catalog,t.objectId).nodes:[t];
      for(const n of nodes) for(const m of modifierTargets.get(key(n.catalog,n.objectId)) ?? []) related.set(`${m.upgradeId}/${m.reference.path}`,m);
    }
    const upgrades=[...new Set([...related.values()].filter(m=>m.contexts.some(c=>c.commanderId===r.commanderId)).map(m=>m.upgradeId))]
      .map(id=>entry('Upgrade',id,'known-profile-modifier',null));
    const compactInternal=internalAbilities.map(({name,target,status,nextQuery})=>({name,target,status,nextQuery}));
    r.directory={attributes,weapons,skills,passives,forms,production,upgrades,internalAbilities:compactInternal,
      otherModifierCandidates:{count:[...related.values()].filter(m=>!m.contexts.some(c=>c.commanderId===r.commanderId)).length,
        nextQuery:query('Unit',id,{topic:'modifiers'})},
      coverage:{listingCompleteWithin:'current indexed Unit attachments, cards and known profile modifiers',
        conditionsEvaluated:false, note:'Internal/unresolved items are separate, not silently omitted. Forms require their own Unit query.'}};
    r.relatedModifierKeys=[...related.values()].map(m=>({upgradeId:m.upgradeId,referencePath:m.reference.path}));
    update.run(JSON.stringify(r),row.commander_id,id);
  }
  const insert=db.prepare('INSERT INTO coop_semantic_details VALUES (?,?,?)');
  for(const root of [...roots.values()].sort((a,b)=>key(a.catalog,a.objectId).localeCompare(key(b.catalog,b.objectId)))) {
    insert.run(root.catalog,root.objectId,JSON.stringify(detail(root.catalog,root.objectId)));
  }
  return {details:roots.size,...saveCommanderDirectories(db,commanderDirectories.records)};
}

export function readDossierDetail(db,input) {
  const row=db.prepare('SELECT record_json FROM main.coop_semantic_details WHERE catalog=? AND object_id=?').get(input.catalog,input.objectId);
  if(!row) return {status:'not-indexed',catalog:input.catalog,objectId:input.objectId};
  const r=JSON.parse(row.record_json),offset=input.offset ?? 0,limit=input.limit ?? 30;
  if(input.commandIndex!==undefined && (input.catalog!=='Abil' || !/^[A-Za-z0-9_]+$/.test(input.commandIndex))) throw Error('commandIndex requires an exact Abil command slot.');
  const prefix=input.commandIndex===undefined ? null : `InfoArray[${input.commandIndex}].`;
  if(prefix) {
    const exists=db.prepare('SELECT 1 FROM main.catalog_fields WHERE catalog=? AND object_id=? AND (substr(path,1,length(?))=? OR path=?) LIMIT 1')
      .get('Abil',input.objectId,prefix,prefix,`InfoArray[${input.commandIndex}]`);
    if(!exists) throw Error('Unknown production/research commandIndex for this Abil.');
  }
  const selectedEdges=r.edges.filter(e=>!prefix || e.from.catalog!==input.catalog || e.from.objectId!==input.objectId
    || !canon(e.via.path).startsWith('InfoArray[') || canon(e.via.path).startsWith(prefix));
  const reachable=new Set([key(input.catalog,input.objectId)]);
  for(let changed=true;changed;) {changed=false;for(const e of selectedEdges) {
    const targetKey=key(e.target.catalog,e.target.objectId);
    if(e.exists && e.role!=='display-only' && reachable.has(key(e.from.catalog,e.from.objectId)) && !reachable.has(targetKey)) {reachable.add(targetKey);changed=true;}
  }}
  const selectedNodes=r.nodes.filter(n=>reachable.has(key(n.catalog,n.objectId)));
  const q=field=>({operation:'entity.get',commanderId:input.commanderId,catalog:field.catalog,objectId:field.objectId,path:field.path});
  const items=selectedNodes.flatMap(n=>n.scalars.filter(s=>!prefix || n.objectId!==input.objectId || !canon(s.field.path).startsWith('InfoArray[') || canon(s.field.path).startsWith(prefix))
    .map(s=>({...s,ownerClass:n.class,nextQuery:q(s.field)})));
  if(input.catalog==='Upgrade') for(const row of db.prepare('SELECT record_json FROM main.coop_semantic_modifiers WHERE upgrade_id=? ORDER BY entry_index').all(input.objectId)) {
    const m=JSON.parse(row.record_json);items.push({label:'升级效果参数',...m,...(m.parameter?{nextQuery:q(m.parameter)}:{})});
  }
  const production=input.catalog==='Abil' ? db.prepare('SELECT record_json FROM main.coop_semantic_production WHERE ability_id=? ORDER BY command_index,target_id').all(input.objectId)
    .map(row=>JSON.parse(row.record_json)).filter(p=>input.commandIndex===undefined || p.commandIndex===input.commandIndex) : [];
  const exists=db.prepare('SELECT 1 FROM main.catalog_objects WHERE catalog=? AND object_id=?');
  return {status:'partial',kind:'object-details',entity:{catalog:r.catalog,objectId:r.objectId,name:r.name},
    commandIndex:input.commandIndex ?? null, total:items.length,offset,nextOffset:offset+limit<items.length?offset+limit:null,
    scalars:items.slice(offset,offset+limit), effectGraph:{nodes:selectedNodes.map(({catalog,objectId,class:cls,conditions})=>({catalog,objectId,class:cls,conditions})),edges:selectedEdges.filter(e=>reachable.has(key(e.from.catalog,e.from.objectId)))},
    production,unresolved:r.unresolved.map(u=>({...u,...(u.catalog && u.objectId && exists.get(u.catalog,u.objectId) ? {nextQuery:{operation:'entity.get',commanderId:input.commanderId,catalog:u.catalog,objectId:u.objectId,include:['fields','relationships']}}:{})})),coverage:r.coverage,
    editGuidance:'Field addresses are official baseline candidates. Read nextQuery for current Map Runtime expect/scope before scalar_solve or editing; no runtime totals or isolation inferred.'};
}
