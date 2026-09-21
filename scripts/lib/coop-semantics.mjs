import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { projectUnitArrayFields } from '../../runtime/coop-mcp/lib/unit-arrays.mjs';
import { canonicalEditPath } from './catalog-edit-contract.mjs';
import { buildCoopDossiers, readDossierDetail, DETAIL_CATALOGS } from './coop-entity-dossiers.mjs';
import { readCommanderDirectory, COMMANDER_SECTIONS } from './coop-commander-dossiers.mjs';
import { createProfileRuleResolver } from './coop-profile-rules.mjs';
import { buildFieldVocabulary } from './field-vocabulary.mjs';
export { COMMANDER_SECTIONS };

// Only parsing rules ship. All records below are derived from the user's local
// official Catalog/profile tables, never from Game A's temporary SQL overlays.
export const COOP_SEMANTIC_VERSION = 6;
const canonical = path => path.replaceAll('.@', '.').replaceAll('[#', '[');
const address = (catalog, objectId, field) => field ? {
  catalog, objectId, path: field.path, value: field.value,
  sourceFile: field.source_file, originObjectId: field.origin_object_id,
  inheritanceDepth: field.inheritance_depth,
} : null;
const numeric = field => field && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(field.value)
  && Number.isFinite(Number(field.value)) ? Number(field.value) : null;
const json = value => JSON.stringify(value);
const sorted = values => [...new Set(values)].sort();
const COVERAGE = {
  status: 'partial', basis: 'official-catalog', runtimeEvaluated: false,
  gameAIncluded: false, engineVerified: false,
  unresolved: ['commander initialization and activation order', 'Galaxy scripts',
    'research/prestige/mastery combinations', 'temporary buffs and engine defaults'],
};

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coop_semantic_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS coop_semantic_entities(
      commander_id TEXT NOT NULL, object_id TEXT NOT NULL, name TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY(commander_id,object_id));
    CREATE TABLE IF NOT EXISTS coop_semantic_production(
      ability_id TEXT NOT NULL, command_index TEXT NOT NULL, target_id TEXT NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY(ability_id,command_index,target_id));
    CREATE INDEX IF NOT EXISTS coop_semantic_production_target ON coop_semantic_production(target_id);
    CREATE TABLE IF NOT EXISTS coop_semantic_modifiers(
      upgrade_id TEXT NOT NULL, entry_index TEXT NOT NULL, target_catalog TEXT NOT NULL,
      target_id TEXT NOT NULL, target_path TEXT NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY(upgrade_id,entry_index));
    CREATE INDEX IF NOT EXISTS coop_semantic_modifier_target ON coop_semantic_modifiers(target_catalog,target_id);
  `);
}

export function semanticStatus(db) {
  if (!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='coop_semantic_meta'").get()) {
    return { status: 'missing', expectedVersion: COOP_SEMANTIC_VERSION,
      action: 'Build the local database or run scripts/casc-database.mjs reindex-semantics <database>.' };
  }
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM main.coop_semantic_meta').all().map(r => [r.key,r.value]));
  const baseline = Object.fromEntries(db.prepare('SELECT key,value FROM main.meta').all().map(r => [r.key,r.value]));
  const valid = Number(meta.version) === COOP_SEMANTIC_VERSION && meta.source === sourceKey(baseline);
  return { status: valid ? 'ready' : 'stale', version: Number(meta.version), expectedVersion: COOP_SEMANTIC_VERSION,
    basis: 'official-catalog', stats: meta.stats ? JSON.parse(meta.stats) : null,
    ...(!valid ? { action: 'Rebuild the local semantic index before querying it.' } : {}) };
}

function sourceKey(meta) {
  // The official baseline is immutable between database builds. Project edits
  // do not invalidate it, since no current-project values are cached here.
  return json(Object.fromEntries(Object.entries(meta).filter(([key]) => !/^(galaxySymbol|engine)/i.test(key)).sort(([a],[b]) => a.localeCompare(b))));
}

/** Atomic/repeatable derived-index rebuild; never changes source tables. */
export function buildCoopSemantics(db) {
  db.exec('SAVEPOINT coop_semantics_build');
  try {
    schema(db);
    for (const table of ['coop_semantic_entities', 'coop_semantic_production', 'coop_semantic_modifiers', 'coop_semantic_meta']) {
      db.exec(`DELETE FROM ${table}`);
    }
    const fieldQuery = db.prepare('SELECT path,value,source_file,origin_object_id,inheritance_depth FROM main.catalog_fields WHERE catalog=? AND object_id=? ORDER BY path');
    const objectQuery = db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?');
    const textQuery = db.prepare("SELECT value FROM main.localized_text WHERE lower(locale) IN ('zhcn','enus') AND text_key=? ORDER BY CASE lower(locale) WHEN 'zhcn' THEN 0 ELSE 1 END LIMIT 1");
    const cache = new Map();
    const fields = (catalog, id) => {
      const key = `${catalog}/${id}`;
      if (!cache.has(key)) cache.set(key, fieldQuery.all(catalog,id));
      return cache.get(key);
    };
    // Preserve exact paths and detect competing canonical spellings.
    const pick = (fs, path) => {
      const matches = fs.filter(f => canonical(f.path) === canonical(path));
      return matches.length === 1 ? matches[0] : null;
    };
    const title = (catalog,id) => textQuery.get(`${catalog}/Name/${id}`)?.value ?? id;
    const links = (catalog,id,pattern) => fields(catalog,id).filter(f => pattern.test(canonical(f.path)));
    const unitLinks = (id,kind) => {
      const fs = fields('Unit',id).filter(f=>f.path.startsWith(`${kind}Array`));
      const projected = projectUnitArrayFields(kind === 'Abil' ? fs : fs.map(f=>({ ...f,
        path:f.path.replace(/^BehaviorArray/,'AbilArray') }))).abilities;
      // Explicit slots override inherited ordinal slots. Preserve the actual
      // source address of the winning Link, not the synthesized slot address.
      return projected.slots.filter(s=>typeof s.attributes.Link==='string' && s.attributes.Link.length>0).map(s=> {
        const paths=s.sourcePaths.map(p=>kind==='Abil' ? p : p.replace(/^AbilArray/,'BehaviorArray'));
        return fs.filter(f=>paths.includes(f.path) && f.value===s.attributes.Link).at(-1);
      }).filter(Boolean);
    };
    const abilityOwners = new Map();
    const memberships = new Map();
    for (const r of db.prepare("SELECT commander_id,object_id,evidence,depth FROM main.commander_membership WHERE catalog='Unit' ORDER BY commander_id,object_id,evidence").all()) {
      if (!memberships.has(r.object_id)) memberships.set(r.object_id,[]);
      memberships.get(r.object_id).push({ commanderId:r.commander_id, evidence:r.evidence, depth:r.depth });
    }
    // Real AbilArray attachment, not the UI-only TechTreeProducedUnitArray.
    for (const unitId of sorted(memberships.keys())) for (const r of unitLinks(unitId,'Abil')) {
      if (!abilityOwners.has(r.value)) abilityOwners.set(r.value,[]);
      abilityOwners.get(r.value).push({ objectId:unitId, attachment:address('Unit',unitId,r),
        commanderAssociations:memberships.get(unitId) ?? [] });
    }
    // A bounded structural spawn path. This is a candidate relationship, NOT
    // proof that every effect executes once (validators/periods/scripts exist).
    function spawnTargets(unitId) {
      const results = [];
      const visit = (catalog,id,chain,seen,depth) => {
        const key = `${catalog}/${id}`;
        if (seen.has(key) || depth > 6) return;
        const nextSeen = new Set([...seen,key]);
        if (catalog === 'Unit') {
          for (const f of unitLinks(id,'Behavior')) visit('Behavior',f.value,[...chain,address(catalog,id,f)],nextSeen,depth+1);
        } else if (catalog === 'Behavior') {
          for (const f of links(catalog,id,/^InitialEffect$/)) visit('Effect',f.value,[...chain,address(catalog,id,f)],nextSeen,depth+1);
        } else if (objectQuery.get('Effect',id)?.class === 'CEffectCreateUnit') {
          const fs = fields('Effect',id), spawn = pick(fs,'SpawnUnit'), count = pick(fs,'SpawnCount');
          if (spawn) results.push({ targetId:spawn.value, count:numeric(count),
            countEvidence:address('Effect',id,count), chain:[...chain,address('Effect',id,spawn)],
            executionVerified:false });
        } else if (objectQuery.get('Effect',id)?.class === 'CEffectSet') {
          for (const f of links('Effect',id,/^EffectArray(?:\[[^\]]+\])?$/)) visit('Effect',f.value,[...chain,address('Effect',id,f)],nextSeen,depth+1);
        }
      };
      visit('Unit',unitId,[],new Set(),0);
      return results;
    }
    const insertProduction = db.prepare('INSERT INTO coop_semantic_production VALUES (?,?,?,?)');
    const productionByTarget = new Map();
    for (const a of db.prepare("SELECT object_id,class FROM main.catalog_objects WHERE catalog='Abil' AND class IN ('CAbilTrain','CAbilWarpTrain') ORDER BY object_id").all()) {
      const fs = fields('Abil',a.object_id), commands = new Map();
      for (const f of fs) {
        const m = canonical(f.path).match(/^InfoArray\[([^\]]+)\]\.Unit(?:\[[^\]]+\])?$/);
        if (!m || !objectQuery.get('Unit',f.value)) continue;
        if (!commands.has(m[1])) commands.set(m[1],[]);
        commands.get(m[1]).push(f);
      }
      for (const [index,units] of commands) {
        const prefix = `InfoArray[${index}]`, targets = new Map();
        for (const unit of units) {
          const direct = { targetId:unit.value, count:1, chain:[address('Abil',a.object_id,unit)], kind:'direct-unit-list' };
          const candidates = [direct,...spawnTargets(unit.value).map(s => ({ ...s, kind:'initial-spawn-chain', chain:[...direct.chain,...s.chain] }))];
          for (const candidate of candidates) {
            if (!targets.has(candidate.targetId)) targets.set(candidate.targetId,[]);
            targets.get(candidate.targetId).push(candidate);
          }
        }
        for (const [target,outputPaths] of targets) {
          const resource = Object.fromEntries(['Minerals','Vespene'].map(r => {
            const f = pick(fs,`${prefix}.Resource[${r}]`);
            return [r, { value:numeric(f), field:address('Abil',a.object_id,f),
              status:f ? 'explicit-command-field' : 'missing-not-zero' }];
          }));
          const time = pick(fs,`${prefix}.Time`);
          const record = { abilityId:a.object_id, commandIndex:index, abilityClass:a.class,
            targetId:target, resource, time:{ value:numeric(time), field:address('Abil',a.object_id,time) },
            outputPaths, listedOutputCount:units.length,
            producedUnitIds:units.map(u => u.value), owners:abilityOwners.get(a.object_id) ?? [],
            requirements:fs.filter(f => canonical(f.path).startsWith(`${prefix}.`) && /Requirements$/.test(canonical(f.path))).map(f=>address('Abil',a.object_id,f)),
            scopeVerified:false, perUnitPriceComputed:false,
            gaps:['Command activation and runtime modifiers not evaluated.',
              'Missing command resources are not assumed zero or automatically replaced with Unit cost.',
              ...(outputPaths.some(p=>p.kind==='initial-spawn-chain') ? ['Spawn counts describe individual effects; execution multiplicity/validators are not evaluated.'] : [])] };
          insertProduction.run(a.object_id,index,target,json(record));
          if (!productionByTarget.has(target)) productionByTarget.set(target,[]);
          productionByTarget.get(target).push(record);
        }
      }
    }
    const contexts = new Map();
    const profileRules=createProfileRuleResolver(db);
    const profiles = db.prepare('SELECT commander_id,profile_json FROM main.commander_profiles ORDER BY commander_id').all()
      .map(row=>({...row,profile_json:json(profileRules.enrich(row.commander_id,JSON.parse(row.profile_json)))}));
    for (const row of profiles) {
      const p = JSON.parse(row.profile_json);
      for (const kind of ['levelPerks','prestiges','masteries']) for (const item of p[kind] ?? []) {
        const ls = item.mappingGaps ? [] : item.links?.length ? item.links : kind==='prestiges' ? [{catalog:'Upgrade',objectId:item.id}] : [];
        for (const link of ls.filter(l=>l.catalog==='Upgrade')) {
          if (!contexts.has(link.objectId)) contexts.set(link.objectId,[]);
          contexts.get(link.objectId).push({ commanderId:row.commander_id, kind, entryId:item.id,
            level:item.level ?? null, index:item.index ?? null, activationVerified:false });
        }
      }
    }
    const insertModifier = db.prepare('INSERT INTO coop_semantic_modifiers VALUES (?,?,?,?,?,?)');
    for (const u of db.prepare("SELECT object_id FROM main.catalog_objects WHERE catalog='Upgrade' ORDER BY object_id").all()) {
      const fs = fields('Upgrade',u.object_id);
      for (const ref of fs) {
        const match = canonical(ref.path).match(/^EffectArray(?:\[([^\]]+)\])?\.Reference$/);
        if (!match) continue;
        const parts = ref.value.split(',');
        if (parts.length < 3) continue;
        const index = match[1] ?? '0', prefix = match[1] == null ? 'EffectArray' : `EffectArray[${match[1]}]`;
        // Legacy flattening stores the uppercase Value attribute on the entry
        // itself. Its editable address must still be explicit .@Value.
        const value = pick(fs,`${prefix}.Value`) ?? pick(fs,prefix), op = pick(fs,`${prefix}.Operation`);
        const target = { catalog:parts[0], objectId:parts[1], path:parts.slice(2).join(',') };
        const record = { upgradeId:u.object_id, entryIndex:index, target,
          operation:op?.value ?? null, operand:numeric(value), parameter:value ? {
            ...address('Upgrade',u.object_id,value), sourcePath:value.path,
            path:canonicalEditPath('CUpgrade',value.path),
          } : null,
          reference:address('Upgrade',u.object_id,ref), operationEvidence:address('Upgrade',u.object_id,op),
          contexts:contexts.get(u.object_id) ?? [], activationVerified:false,
          targetExists:Boolean(objectQuery.get(target.catalog,target.objectId)),
          gaps:['No activation/order inference from the existence of an Upgrade.',
            ...(!op ? ['Missing Operation requires engine/default verification; not assumed Add.'] : [])] };
        // The legacy source can expose indexed/unindexed or attribute/element
        // projections together. Keep every evidence row instead of overwriting
        // one based on a guessed canonical index.
        insertModifier.run(u.object_id,ref.path,target.catalog,target.objectId,canonical(target.path),json(record));
      }
    }
    const insertEntity = db.prepare('INSERT INTO coop_semantic_entities VALUES (?,?,?,?)');
    for (const row of profiles) {
      const p = JSON.parse(row.profile_json), entities = new Map();
      for (const kind of ['units','buildings']) for (const item of p.roster?.[kind] ?? []) {
        if (!item.unitId) continue;
        if (!entities.has(item.unitId)) entities.set(item.unitId,{ ...item, rosterKind:kind, aliases:[] });
        entities.get(item.unitId).aliases.push(...[item.techId,item.nameZhCN,item.nameEnUS].filter(Boolean));
      }
      const extraUnits=[...(p.panel?.casterUnit?[{objectId:p.panel.casterUnit,source:'panel-caster'}]:[]),
        ...['levelPerks','prestiges','masteries'].flatMap(kind=>(p[kind] ?? []).flatMap(item=>(item.links ?? [])
          .filter(l=>l.catalog==='Unit').map(l=>({...l,source:`profile-${kind}`}))))];
      for(const item of extraUnits) if(!entities.has(item.objectId) && objectQuery.get('Unit',item.objectId))
        entities.set(item.objectId,{aliases:[],source:item.source,rosterKind:'profile-linked'});
      for (const [id,item] of entities) {
        const fs = fields('Unit',id);
        const facts = Object.fromEntries(['CostResource[Minerals]','CostResource[Vespene]','Food','LifeMax','ShieldsMax','LifeArmor'].map(path=> {
          const f = pick(fs,path); return [path,{ value:numeric(f), field:address('Unit',id,f) }];
        }));
        const distinctAbilities = new Map(unitLinks(id,'Abil').map(link=>[link.value,link]));
        // Also index explicitly linked morph forms so first-level form links
        // lead to another navigable Unit, without guessing suffixes/names.
        for (const link of distinctAbilities.values()) {
          if (!/^CAbilMorph/.test(objectQuery.get('Abil',link.value)?.class ?? '')) continue;
          for (const f of fields('Abil',link.value).filter(f=>/^InfoArray.*\.Unit(?:\[[^\]]+\])?$/.test(canonical(f.path)))) {
            if (!entities.has(f.value) && objectQuery.get('Unit',f.value) && entities.size<128) {
              entities.set(f.value,{aliases:[],source:'explicit-morph-target',rosterKind:item.rosterKind});
            }
          }
        }
        const projectedCards = projectUnitArrayFields(fs).commandCards.flatMap(card=>card.slots);
        const abilities = [...distinctAbilities.values()].map(link=> {
          const abilityId = link.value, af = fields('Abil',abilityId);
          const cards = projectedCards.filter(s=>s.attributes.Type !== 'None'
            && String(s.attributes.AbilCmd ?? '').split(',')[0]===abilityId).map(s=> {
            const f = fs.filter(f=>s.sourcePaths.includes(f.path) && /\.AbilCmd$/.test(canonical(f.path)) && f.value===s.attributes.AbilCmd).at(-1);
            return { command:s.attributes.AbilCmd, field:address('Unit',id,f), face:s.attributes.Face ?? null,
              name:s.attributes.Face ? title('Button',s.attributes.Face) : null,
              requirements:s.attributes.Requirements ?? null };
          });
          const displayButtons = af.filter(f=>/^CmdButtonArray(?:\[[^\]]+\])?\.DefaultButtonFace$/.test(canonical(f.path)) && f.value)
            .map(f=>({buttonId:f.value,name:title('Button',f.value),field:address('Abil',abilityId,f)}));
          return { catalog:'Abil', objectId:abilityId, class:objectQuery.get('Abil',abilityId)?.class ?? null,
            attachment:address('Unit',id,link), commands:cards, displayButtons,
            numericFields:af.filter(f=>/^Cost\.(?:Vital\[Energy\]|Cooldown\.TimeUse)$/.test(canonical(f.path))).map(f=>address('Abil',abilityId,f)),
            effectEntrypoints:af.filter(f=>/^Effect(?:\[[^\]]+\])?$/.test(canonical(f.path))).map(f=>address('Abil',abilityId,f)),
            requirements:af.filter(f=>/Requirements$/.test(canonical(f.path))).map(f=>address('Abil',abilityId,f)),
            availability:'attached-not-proven-unlocked', cooldownMeaning:'raw-field-not-complete-runtime-rule' };
        });
        const behaviors = [...new Map(unitLinks(id,'Behavior').map(f=>[f.value,f])).values()]
          .map(f=>({catalog:'Behavior',objectId:f.value,attachment:address('Unit',id,f),meaning:'attached-behavior-not-proven-player-skill'}));
        const routes = (productionByTarget.get(id) ?? []).filter(r=>r.owners.some(o=>o.commanderAssociations.some(c=>c.commanderId===row.commander_id)));
        const record = { commanderId:row.commander_id, catalog:'Unit', objectId:id,
          name:item.nameZhCN ?? item.nameEnUS ?? title('Unit',id), aliases:sorted(item.aliases),
          identity:{ status:/ACGluescreenDummy$/i.test(id) ? 'display-object-unresolved' : 'profile-linked',
            rosterKind:item.rosterKind, profileSource:item.source, unlockedAtLevel:item.unlockedAtLevel ?? null,
            note:'Profile association is evidence, not proof of complete runtime ownership.' },
          catalogFacts:facts, abilities, behaviors,
          productionKeys:routes.map(r=>({abilityId:r.abilityId,commandIndex:r.commandIndex})),
          coverage:COVERAGE };
        insertEntity.run(row.commander_id,id,record.name,json(record));
      }
    }
    const dossierStats = buildCoopDossiers(db);
    const { perCatalog: _fieldCatalogCounts, ...fieldVocabulary } = buildFieldVocabulary(db);
    const stats = { ...dossierStats, fieldVocabulary, ...Object.fromEntries(['entities','production','modifiers'].map(name=>[name,
      db.prepare(`SELECT count(*) n FROM coop_semantic_${name}`).get().n])) };
    const baseline = Object.fromEntries(db.prepare('SELECT key,value FROM main.meta').all().map(r=>[r.key,r.value]));
    const put = db.prepare('INSERT INTO coop_semantic_meta VALUES (?,?)');
    put.run('version',String(COOP_SEMANTIC_VERSION)); put.run('source',sourceKey(baseline)); put.run('stats',json(stats));
    db.exec('RELEASE coop_semantics_build');
    return { version:COOP_SEMANTIC_VERSION, ...stats, coverage:COVERAGE };
  } catch (error) {
    db.exec('ROLLBACK TO coop_semantics_build; RELEASE coop_semantics_build');
    throw error;
  }
}

export function reindexCoopSemantics(databaseFile) {
  if (!existsSync(databaseFile)) throw Error('Baseline database does not exist; build it from the local SC2 installation first.');
  const db = new DatabaseSync(databaseFile, { timeout:2000 });
  try { return buildCoopSemantics(db); } finally { db.close(); }
}

export function readCoopEntityFacts(db, input) {
  if (typeof input.objectId !== 'string' || !input.objectId.trim() || input.query !== undefined) {
    throw Error('Prebuilt entity facts require an exact objectId; resolve the target ID first. Name queries are not supported here.');
  }
  if (input.prestigeUpgrade || input.path) {
    throw Error('Prebuilt entity facts are official baseline only; use entity.get/scalar_solve for a scoped/current field.');
  }
  const status = semanticStatus(db);
  const header = { semanticIndex:status, basis:'official-catalog', currentProjectIncluded:false, coverage:COVERAGE };
  if (status.status !== 'ready') return { ...header, status:status.status };
  if (!input.commanderId) throw Error('Prebuilt entity facts require commanderId.');
  const commander = db.prepare('SELECT id FROM main.commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)').get(input.commanderId,input.commanderId);
  if (!commander) throw Error('Unknown commanderId.');
  header.commanderId = commander.id;
  if(input.catalog==='Commander') {
    const root=db.prepare('SELECT commander_object_id FROM main.commanders WHERE id=?').get(commander.id);
    if(input.objectId!==root.commander_object_id) return {...header,status:'not-indexed',note:'Commander objectId does not match commanderId.'};
    return {...header,...readCommanderDirectory(db,{...input,commanderId:commander.id})};
  }
  if (DETAIL_CATALOGS.includes(input.catalog)) {
    if (!Number.isInteger(input.offset ?? 0) || (input.offset ?? 0)<0 || !Number.isInteger(input.limit ?? 30) || (input.limit ?? 30)<1 || (input.limit ?? 30)>100) throw Error('Invalid semantic pagination.');
    return {...header,...readDossierDetail(db,{...input,commanderId:commander.id})};
  }
  if (input.catalog && input.catalog !== 'Unit') return {...header,status:'not-indexed'};
  const topic = input.topic ?? 'overview', offset = input.offset ?? 0, limit = input.limit ?? 20;
  if (!['overview','production','abilities','modifiers'].includes(topic)) throw Error('Unknown semantic topic.');
  if (!Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>100) throw Error('Invalid semantic pagination.');
  header.commanderId = commander.id;
  const row = db.prepare('SELECT record_json FROM main.coop_semantic_entities WHERE commander_id=? AND object_id=?')
    .get(commander.id,input.objectId.trim());
  if (!row) return { ...header, status:'not-indexed', objectId:input.objectId,
    note:'No prebuilt record for this exact commander/object ID. Continue using its fields/relationships; do not substitute another object.' };
  const r = JSON.parse(row.record_json), { abilities,behaviors,productionKeys,directory,relatedModifierKeys,...entity } = r;
  if (topic==='overview') return {...header,status:'partial',kind:'unit-directory',entity:{catalog:'Unit',objectId:r.objectId,name:r.name,identity:r.identity},directory};
  const routes = productionKeys.map(k=>JSON.parse(db.prepare('SELECT record_json FROM main.coop_semantic_production WHERE ability_id=? AND command_index=? AND target_id=?').get(k.abilityId,k.commandIndex,r.objectId).record_json));
  const targets = [{catalog:'Unit',objectId:r.objectId},...abilities,...behaviors,...routes.map(r=>({catalog:'Abil',objectId:r.abilityId}))];
  const mods = new Map();
  const findMods = db.prepare('SELECT record_json FROM main.coop_semantic_modifiers WHERE target_catalog=? AND target_id=? ORDER BY upgrade_id,entry_index');
  for (const t of targets) for (const row of findMods.all(t.catalog,t.objectId)) {
    const m = JSON.parse(row.record_json); mods.set(`${m.upgradeId}/${m.reference.path}`,m);
  }
  const findRelated=db.prepare('SELECT record_json FROM main.coop_semantic_modifiers WHERE upgrade_id=? AND entry_index=?');
  for(const k of relatedModifierKeys ?? []) {
    const row=findRelated.get(k.upgradeId,k.referencePath);
    if(row){const m=JSON.parse(row.record_json);mods.set(`${m.upgradeId}/${m.reference.path}`,m);}
  }
  const items = topic==='abilities' ? [...abilities,...behaviors] : topic==='modifiers' ? [...mods.values()] : routes;
  return { ...header, status:'partial', entity, topic,
    counts:{production:routes.length,abilities:abilities.length,behaviors:behaviors.length,modifierCandidates:mods.size},
    total:items.length, offset, nextOffset:offset+limit<items.length ? offset+limit : null,
    [topic==='overview' ? 'production' : topic]:items.slice(offset,offset+limit),
    editGuidance:'These are baseline field/parameter candidates, not executable edits. Use entity.get/scalar_solve against the current Game A snapshot for fresh expect, scope, isolation and conditions. Never infer no modifiers from an empty/incomplete list.' };
}

export function readCoopCommanderFacts(db,input) {
  const status=semanticStatus(db);
  const header={semanticIndex:status,basis:'official-catalog',currentProjectIncluded:false};
  if(status.status!=='ready') return {...header,status:status.status};
  const c=db.prepare('SELECT id FROM main.commanders WHERE lower(id)=lower(?) OR lower(commander_object_id)=lower(?)').get(input.commanderId,input.commanderId);
  if(!c) throw Error('Unknown commanderId.');
  return {...header,...readCommanderDirectory(db,{...input,commanderId:c.id})};
}
