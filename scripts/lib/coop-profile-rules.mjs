import { DOMParser } from '@xmldom/xmldom';
import { applyReviewedLinks } from './coop-reviewed-links.mjs';

const children=n=>Array.from(n?.childNodes ?? []).filter(n=>n.nodeType===1);
const attr=(n,k)=>n?.getAttribute(k) || null;
const field=n=>children(n).find(n=>n.tagName==='Field');
// Read typed UserData, not similarly named Catalog objects. This also works
// on old local databases without mutating their original profile records.
export function createProfileRuleResolver(db) {
  const hasXml=db.prepare('PRAGMA main.table_info(catalog_objects)').all().some(c=>c.name==='direct_xml');
  const users=new Map();
  const instances=id=> {
    if(!users.has(id)) {
      const row=hasXml?db.prepare("SELECT direct_xml,source_file FROM main.catalog_objects WHERE catalog='User' AND object_id=?").get(id):null;
      const doc=row?.direct_xml?new DOMParser().parseFromString(row.direct_xml,'text/xml'):null;
      users.set(id,new Map(children(doc?.documentElement).filter(n=>n.tagName==='Instances').map(n=>[attr(n,'Id'),{node:n,sourceFile:row.source_file}])));
    }
    return users.get(id);
  };
  const find=(type,id)=>instances(type).get(id);
  const typed=(type,id,fieldId,tag)=>children(find(type,id)?.node).filter(n=>attr(field(n),'Id')===fieldId && (!tag || n.tagName===tag));
  const evidence=(type,id,fieldId)=>({rule:'typed-userdata-v1',catalog:'User',objectId:type,instanceId:id,fieldId,sourceFile:find(type,id)?.sourceFile});
  const enrich=(commanderId,profile)=> {
    const p=structuredClone(profile);
    p.prestiges=(p.prestiges ?? []).map(item=> {
      const candidates=typed('PlayerCommanders',commanderId,'Prestige','User')
        .filter(n=>attr(n,'Type')==='PlayerPrestige' && Number(attr(field(n),'Index') ?? 0)===Number(item.index));
      if(!candidates.length) return item;
      if(candidates.length!==1) return {...item,primaryUpgrade:null,links:[],mappingStatus:'ambiguous-userdata',mappingGaps:['multiple-prestige-instances-for-slot']};
      const instanceId=attr(candidates[0],'Instance');
      const primary=typed('PlayerPrestige',instanceId,'PrimaryUpgrade','GameLink');
      if(primary.length!==1 || !attr(primary[0],'GameLink')) return {...item,primaryUpgrade:null,links:[],mappingStatus:'unresolved-userdata',mappingGaps:['missing-or-ambiguous-primary-upgrade']};
      const primaryUpgrade=attr(primary[0],'GameLink');
      const links=[{catalog:'Upgrade',objectId:primaryUpgrade,role:'primary-prestige-upgrade',
        evidence:[evidence('PlayerCommanders',commanderId,'Prestige'),evidence('PlayerPrestige',instanceId,'PrimaryUpgrade')]}];
      for (const fieldId of ['SecondaryUpgradesSelf','SecondaryUpgradesShared']) {
        for (const n of typed('PlayerPrestige',instanceId,fieldId,'GameLink')) if (attr(n,'GameLink'))
          links.push({catalog:'Upgrade',objectId:attr(n,'GameLink'),role:'secondary-prestige-upgrade',fieldId,
            recipientScope:fieldId==='SecondaryUpgradesShared'?'commander-players':'self',
            evidence:[evidence('PlayerPrestige',instanceId,fieldId)]});
      }
      for(const n of typed('PlayerPrestige',instanceId,'UpgradeSupplements','User')) {
        if(attr(n,'Type')!=='PlayerPrestigeUpgradeSupplements') continue;
        const sid=attr(n,'Instance');
        const when=typed('PlayerPrestigeUpgradeSupplements',sid,'Upgrade','GameLink').map(n=>attr(n,'GameLink')).filter(Boolean);
        for(const s of typed('PlayerPrestigeUpgradeSupplements',sid,'Supplement','GameLink')) if(attr(s,'GameLink'))
          links.push({catalog:'Upgrade',objectId:attr(s,'GameLink'),role:'conditional-prestige-supplement',
            requiredUpgrades:when,activationVerified:false,evidence:[evidence('PlayerPrestige',instanceId,'UpgradeSupplements'),evidence('PlayerPrestigeUpgradeSupplements',sid,'Supplement')]});
      }
      for(const n of children(find('PlayerPrestige',instanceId)?.node)) if(n.tagName==='AbilCmd' && attr(n,'Abil'))
        links.push({catalog:'Abil',objectId:attr(n,'Abil'),commandIndex:Number(attr(n,'Cmd') ?? 0),role:attr(field(n),'Id'),
          evidence:[evidence('PlayerPrestige',instanceId,attr(field(n),'Id'))]});
      return {...item,primaryUpgrade,prestigeInstanceId:instanceId,links,
        supersededLinks:item.supersededLinks ?? item.links ?? [{catalog:'Upgrade',objectId:item.id}],
        mappingStatus:'typed-userdata-linked-not-runtime-verified'};
    });
    for(const item of p.levelPerks ?? []) {
      const extra=[];
      for(const link of item.links ?? []) if(link.catalog==='ArmyCategory') {
        const rows=db.prepare("SELECT path,value,source_file FROM main.catalog_fields WHERE catalog='ArmyCategory' AND object_id=? AND path='Unit'").all(link.objectId);
        if(rows.length===1 && rows[0].value) extra.push({catalog:'Unit',objectId:rows[0].value,role:'army-category-unit',
          evidence:{rule:'army-category-unit-v1',catalog:'ArmyCategory',objectId:link.objectId,path:rows[0].path,sourceFile:rows[0].source_file}});
      }
      if(extra.length) item.links=[...new Map([...(item.links ?? []),...extra].map(l=>[JSON.stringify(l),l])).values()];
    }
    return applyReviewedLinks(db,commanderId,p);
  };
  return {enrich};
}

export function readLinkedCommanderProfile(db,commanderId,profile) {
  return createProfileRuleResolver(db).enrich(commanderId,profile);
}

// Only a verified existing Upgrade can be an activation condition. Never
// authorize a display alias simply because it was listed in Commander UI data.
export function prestigeActivationId(db,entry) {
  if(['ambiguous-userdata','unresolved-userdata'].includes(entry.mappingStatus)) return null;
  const id=entry.primaryUpgrade ?? entry.id;
  return db.prepare("SELECT 1 FROM main.catalog_objects WHERE catalog='Upgrade' AND object_id=?").get(id)?id:null;
}
