// Current, typed production/morph edges. Directory membership is context, not
// proof that a similarly named unit is the playable result of that directory.
const canonical=p=>String(p).replaceAll('.@','.').replace(/\[#(\d+)\]/g,'[$1]');
export function createUnitIdentityReader(db,{commanderId,prestigeUpgrade}={}) {
  const cache=new Map(),rowCache=new Map();
  const context={...(commanderId?{commanderId}:{}),...(prestigeUpgrade?{prestigeUpgrade}:{})};
  const query=(catalog,objectId,path)=>({operation:'entity.get',...context,catalog,objectId,...(path?{path}:{})});
  const fields=(catalog,id)=>{
    const key=`${catalog}/${id}`;if(!rowCache.has(key))rowCache.set(key,db.prepare('SELECT path,value,source_file FROM catalog_fields WHERE catalog=? AND object_id=?').all(catalog,id));
    return rowCache.get(key);
  };
  const current=(catalog,id,p)=>fields(catalog,id).find(f=>canonical(f.path)===canonical(p));
  const membership=id=>commanderId?db.prepare("SELECT depth,evidence FROM commander_membership WHERE commander_id=? AND catalog='Unit' AND object_id=? ORDER BY depth,evidence").all(commanderId,id):[];
  const anchor=id=>membership(id).filter(m=>m.depth===0 && /(?:TechUnit|HeroUnit|HeroReviveUnit|HeroStructure)/i.test(m.evidence));
  function read(objectId,{summary=false}={}) {
    if(!cache.has(objectId)) {
      const routes=[];let truncated=false,visitedCount=0;
      function visit(id,steps,seen) {
        if(seen.has(id))return;
        if(steps.length>=3||visitedCount++>=48){truncated=true;return;}
        const visited=new Set([...seen,id]);
        const refs=db.prepare(`SELECT r.source_object_id AS abilityId,r.field_path AS path,o.class
          FROM object_references r JOIN catalog_objects o ON o.catalog='Abil' AND o.object_id=r.source_object_id
          WHERE r.target_catalog='Unit' AND r.target_object_id=? AND r.source_catalog='Abil'
          AND o.class IN ('CAbilTrain','CAbilWarpTrain','CAbilMorph') ORDER BY abilityId,path LIMIT 17`).all(id);
        if(refs.length>16)truncated=true;
        for(const ref of refs.slice(0,16)) {
          const match=/^(InfoArray(?:\[[^\]]+\])?)\.Unit(?:\[[^\]]+\])?$/.exec(canonical(ref.path));
          if(!match||current('Abil',ref.abilityId,ref.path)?.value!==id)continue;
          const stem=match[1],state=current('Abil',ref.abilityId,`${stem}.Button.State`),requirement=current('Abil',ref.abilityId,`${stem}.Button.Requirements`);
          const owners=db.prepare(`SELECT source_object_id AS objectId,field_path AS path FROM object_references
            WHERE target_catalog='Abil' AND target_object_id=? AND source_catalog='Unit' ORDER BY objectId,path LIMIT 33`).all(ref.abilityId);
          if(owners.length>32)truncated=true;
          for(const owner of owners.slice(0,32)) {
            if(!/^AbilArray(?:\[[^\]]+\])?\.Link$/.test(canonical(owner.path))||current('Unit',owner.objectId,owner.path)?.value!==ref.abilityId)continue;
            // Self morph abilities can be present on both forms; a self edge
            // is not a production route and must not mask the other form.
            if(owner.objectId===id)continue;
            const step={producerId:owner.objectId,abilityId:ref.abilityId,abilityClass:ref.class,resultId:id,
              output:{path:ref.path,source:current('Abil',ref.abilityId,ref.path).source_file,nextQuery:query('Abil',ref.abilityId,ref.path)},
              attachment:{path:owner.path,nextQuery:query('Unit',owner.objectId,owner.path)},
              buttonState:state?.value??null,...(state?{buttonStateQuery:query('Abil',ref.abilityId,state.path)}:{}),
              requirement:requirement?.value?{id:requirement.value,nextQuery:{operation:'requirement.explain',...context,objectId:requirement.value}}:null};
            const chain=[step,...steps],evidence=anchor(owner.objectId);
            routes.push({producerId:owner.objectId,commanderAnchor:evidence,steps:chain,
              restrictedInCatalog:chain.some(s=>['Restricted','Suppressed'].includes(s.buttonState)),runtimeAvailable:null});
            if(!evidence.length)visit(owner.objectId,chain,visited);
          }
        }
      }
      visit(objectId,[],new Set());
      routes.sort((a,b)=>Number(Boolean(b.commanderAnchor.length)&&!b.restrictedInCatalog)-Number(Boolean(a.commanderAnchor.length)&&!a.restrictedInCatalog)||a.steps.length-b.steps.length||a.producerId.localeCompare(b.producerId));
      cache.set(objectId,{kind:'unit-production-identity',objectId,context,directoryEvidence:membership(objectId),
        hasCommanderProductionRoute:routes.some(r=>r.commanderAnchor.length&&!r.restrictedInCatalog),routes,
        truncated,runtimeVerified:false,
        boundary:'Typed current production/morph routes distinguish playable results, cocoons and alternate forms. Commander.UnitArray is directory association, not a production proof. Button restrictions, requirements, upgrades and scripts are not runtime-evaluated; no route does not prove unavailability.'});
    }
    const result=cache.get(objectId);
    if(summary)return {hasCommanderProductionRoute:result.hasCommanderProductionRoute,
      routes:result.routes.slice(0,1),truncated:result.truncated||result.routes.length>1,runtimeVerified:false,
      nextQuery:{...query('Unit',objectId),topic:'identity'}};
    return {...result,routes:result.routes.slice(0,12),truncated:result.truncated||result.routes.length>12};
  }
  return {read};
}
