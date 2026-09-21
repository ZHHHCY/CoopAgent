// Profile links are explicit database evidence, not name-based effect guesses.
import { readLinkedCommanderProfile } from '../../../scripts/lib/coop-profile-rules.mjs';
export function commanderNavigation(database, commanderId, profile) {
  profile=readLinkedCommanderProfile(database,commanderId,profile);
  const find = database.prepare('SELECT catalog, object_id AS objectId FROM catalog_objects WHERE catalog=? AND object_id=?');
  const cache = new Map();
  const address = (catalog, objectId) => {
    if (!catalog || !objectId) return null;
    const key = `${catalog}/${objectId}`;
    if (!cache.has(key)) {
      const row = find.get(catalog, objectId);
      cache.set(key, row ? { ...row } : null);
    }
    return cache.get(key);
  };
  const entry = (item, collection, index, links = item.links ?? []) => {
    const targets = [], missing = [], displays = [];
    const seen = new Set();
    for (const link of links) {
      if (!link.catalog || !link.objectId) continue;
      const key = `${link.catalog}/${link.objectId}/${link.commandIndex ?? ''}/${link.fieldId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = address(link.catalog, link.objectId);
      const ref = { catalog: link.catalog, objectId: link.objectId,
        ...(link.role?{role:link.role}:{}),
        ...(link.evidence?{evidence:link.evidence}:{}),
        ...(link.requiredUpgrades?{requiredUpgrades:link.requiredUpgrades,activationVerified:false}:{}),
        ...(link.fieldId ? { role: link.fieldId } : {}),
        ...(link.commandIndex != null ? { commandIndex: link.commandIndex } : {}) };
      if (!target) missing.push(ref);
      else if (['Button', 'Talent'].includes(target.catalog)) displays.push(target);
      else targets.push({ ...ref, ...target });
    }
    const presentation = address('Button', item.id) ?? displays.find(x => x.catalog === 'Button') ?? displays[0] ?? null;
    return { id: item.id, ...(item.primaryUpgrade?{primaryUpgrade:item.primaryUpgrade}:{}),
      ...(item.mappingStatus?{mappingStatus:item.mappingStatus}:{}),
      ...(item.reviewedRules?{reviewedRules:item.reviewedRules}:{}), ...(item.level != null ? { level: item.level } : {}),
      ...(item.levelId ? { levelId: item.levelId } : {}),
      presentation, effectTargets: targets.map(target => ({...target,
        nextQuery:{operation:'entity.get',commanderId,catalog:target.catalog,objectId:target.objectId,
          ...(target.commandIndex!=null?{commandIndex:target.commandIndex}:{}),
          ...(collection==='masteries'&&target.catalog==='Upgrade'?{topic:'mastery'}:{})},
      })),
      ...(collection==='masteries'?{editingNote:
        'Upgrade EffectArray entries define per-level effects: inspect Reference, Operation and Value together and reuse exact edit operations. User/MasteryUpgrades PointIncrement is presentation metadata, not proof of the gameplay coefficient. A numeric effect request does not by itself require editing mastery UI metadata. Preserve real array paths; an Instances Id is not its index.'}:{}),
      navigation: { status: targets.length ? (missing.length ? 'partial' : 'linked') : 'unresolved',
        evidence: { commanderId, profilePath: `${collection}[${index}]${collection === 'prestiges' ? '' : '.links'}` },
        ...(missing.length ? { unresolvedTargets: missing } : {}),
        ...(!targets.length ? { reason: 'No existing effect target is recorded here; this does not prove the entry has no effect.' } : {}) } };
  };
  return {
    levelPerks: (profile.levelPerks ?? []).map((item, i) => entry(item, 'levelPerks', i)),
    masteries: (profile.masteries ?? []).map((item, i) => entry(item, 'masteries', i)),
    prestiges: (profile.prestiges ?? []).map((item, i) => entry(item, 'prestiges', i,
      item.mappingGaps ? [] : item.links?.length ? item.links : [{ catalog: 'Upgrade', objectId: item.id, fieldId: 'PrestigeArray' }])),
  };
}

export function findCommanderEntries(database, commanderId, objectId, catalog = null) {
  if (!commanderId) return [];
  const row = database.prepare(`SELECT p.commander_id AS commanderId, p.profile_json AS profileJson
    FROM commander_profiles p JOIN commanders c ON c.id=p.commander_id
    WHERE lower(c.id)=lower(?) OR lower(c.commander_object_id)=lower(?)`).get(commanderId, commanderId);
  if (!row) return [];
  const profile = JSON.parse(row.profileJson);
  const navigation = commanderNavigation(database, row.commanderId, profile);
  const same = value => value?.toLowerCase() === objectId.toLowerCase();
  return Object.entries(navigation).flatMap(([collection, entries]) => entries.flatMap((entry, i) => {
    const matches = catalog ? (same(entry.presentation?.objectId) && sameCatalog(entry.presentation?.catalog, catalog)
      || entry.effectTargets.some(target => same(target.objectId) && sameCatalog(target.catalog, catalog)))
      : same(entry.id);
    return matches ? [{ ...entry, kind: collection,
      nameZhCN: profile[collection][i].nameZhCN ?? null, nameEnUS: profile[collection][i].nameEnUS ?? null }] : [];
  }));
}

const sameCatalog = (a, b) => a?.toLowerCase() === b?.toLowerCase();
