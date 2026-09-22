// Reverse evidence for a field, not a runtime evaluator. Reads the same
// connection-local Map Runtime overlay as entity.get; never writes/rebuilds the DB.
import { canonicalEditPath } from '../../../scripts/lib/catalog-edit-contract.mjs';
import { createProfileRuleResolver } from '../../../scripts/lib/coop-profile-rules.mjs';
import { commanderStatIdentity } from '../../../scripts/lib/patch-plan-executor.mjs';
import { projectUnitArrayFields } from './unit-arrays.mjs';
import { UNIT_INFLUENCE_POLICY, profileGrantRoute, classifyActivation, createResearchRouteReader } from './upgrade-activation.mjs';

const canonical = p => String(p).replaceAll('.@', '.').replace(/\[#(\d+)\]/g, '[$1]');
const numeric = s => typeof s === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s) && Number.isFinite(Number(s));
const SCAN_LIMIT = 2048;
export const INFLUENCE_BOUNDARY = {
  valueMeaning: 'catalog-or-edit-value-not-final-gameplay-value', runtimeEvaluated: false, runtimeValue: null,
  influenceBasis: 'current-project-catalog-reference-evidence',
  note: '字段值/修改参数不等于游戏内最终值。以下是影响候选，不表示全部激活；顺序、等级、层数与条件尚未求值。空列表不证明没有修正。',
  taskPolicy: UNIT_INFLUENCE_POLICY,
  setRisk: '开局修正中的 Set 顺序可能影响请求数值；局内研究中的 Set 默认仅为后续参考，不自动扩大单位修改范围。',
};

export function createFieldInfluenceReader(db, input, { applied = [] } = {}) {
  const { catalog, objectId } = input;
  const context = { ...(input.commanderId ? { commanderId: input.commanderId } : {}), ...(input.prestigeUpgrade ? { prestigeUpgrade: input.prestigeUpgrade } : {}) };
  const root = { operation: 'entity.get', catalog, objectId, ...context };
  const query = (c, id, path) => ({ operation: 'entity.get', catalog: c, objectId: id, ...context, ...(path ? { path } : {}) });
  const rowsCache = new Map();
  const fields = (c, id) => {
    const k = JSON.stringify([c, id]);
    if (!rowsCache.has(k)) rowsCache.set(k, db.prepare('SELECT path,value,source_file,origin_object_id,inheritance_depth FROM catalog_fields WHERE catalog=? AND object_id=?').all(c, id));
    return rowsCache.get(k);
  };
  const pick = (rows, p) => {
    let xs = rows.filter(r => canonical(r.path) === canonical(p));
    if (xs.some(r => !r.path.includes('[#'))) xs = xs.filter(r => !r.path.includes('[#'));
    return xs.length === 1 ? xs[0] : null;
  };
  const title = (c, id) => {
    const key = (pick(fields(c, id), 'Name')?.value ?? `${c}/Name/${id}`).replaceAll('##id##', id);
    return db.prepare("SELECT value FROM localized_text WHERE text_key=? AND lower(locale) IN ('zhcn','enus') ORDER BY CASE lower(locale) WHEN 'zhcn' THEN 0 ELSE 1 END LIMIT 1").get(key)?.value?.split(/\s*\/\/\/\s*/)[0] ?? id;
  };
  const source = (c, id, f) => ({ catalog: c, objectId: id, path: f.path, file: f.source_file,
    originObjectId: f.origin_object_id, inheritanceDepth: f.inheritance_depth });
  const researchRoutes = createResearchRouteReader(db, { fields, pick, canonical, query });
  let conditions;
  function conditionMap() {
    if (conditions) return conditions;
    conditions = new Map();
    const add = (id, value) => conditions.set(id, [...(conditions.get(id) ?? []), value]);
    const resolver = createProfileRuleResolver(db);
    const build = db.prepare("SELECT value FROM main.meta WHERE key='sc2Build'").get()?.value;
    for (const row of db.prepare('SELECT commander_id,profile_json FROM main.commander_profiles ORDER BY commander_id').all()) {
      const profile = resolver.enrich(row.commander_id, JSON.parse(row.profile_json));
      for (const id of profile.panel?.defaultUpgrades ?? []) add(id, {
        kind:'defaultUpgrades',commanderId:row.commander_id,entryId:id,
        selectedCommanderMatches:input.commanderId?input.commanderId===row.commander_id:null,
        activationVerified:false,basis:'PlayerCommanders.DefaultUpgrades',
        grantRoute:profileGrantRoute(build,'defaultUpgrades'),
        nextQuery:{operation:'commander.get',commanderId:row.commander_id,topic:'defaultUpgrades'},
      });
      for (const kind of ['levelPerks', 'prestiges', 'masteries']) for (const item of profile[kind] ?? []) {
        if (item.mappingGaps) continue;
        const links = item.links?.length ? item.links : kind === 'prestiges' ? [{ catalog: 'Upgrade', objectId: item.primaryUpgrade ?? item.id }] : [];
        for (const link of links.filter(l => l.catalog === 'Upgrade')) add(link.objectId, {
          kind, commanderId: row.commander_id, entryId: item.id, name: item.nameZhCN ?? item.nameEnUS ?? item.id,
          ...(item.level != null ? { level: item.level } : {}),
          ...(kind === 'prestiges' ? { prestigeIndex: item.index, primaryUpgrade: item.primaryUpgrade ?? link.objectId } : {}),
          ...(link.requiredUpgrades ? { requiredUpgrades: link.requiredUpgrades } : {}),
          ...(link.recipientScope ? { recipientScope: link.recipientScope } : {}),
          grantRoute: profileGrantRoute(build,kind,link),
          selectedCommanderMatches: input.commanderId ? input.commanderId === row.commander_id : null,
          activationVerified: false, basis: 'profile-link',
          nextQuery: { operation: 'commander.get', commanderId: row.commander_id, topic: kind },
        });
      }
    }
    // Receipts provide scope/history only. Operands always come from current XML
    // fields below, not from possibly superseded plan values.
    const latest = new Map();
    for (const item of applied) if (item.operation.kind === 'commander.stat.set') latest.set(commanderStatIdentity(item.operation).upgradeId, item);
    for (const [id, { operation: op, planId }] of latest) add(id, {
      kind: 'project-scope', commanderId: op.commanderId, prestigeUpgrade: op.prestigeUpgrade ?? null,
      selectedCommanderMatches: input.commanderId ? input.commanderId === op.commanderId : null,
      selectedPrestigeMatches: op.prestigeUpgrade ? input.prestigeUpgrade ? op.prestigeUpgrade === input.prestigeUpgrade : null : null,
      planId, activationVerified: false, basis: 'applied-plan-scope-not-runtime',
      grantRoute:{kind:'startup-automatic',basis:'generated-commander-configuration-intent',conditionsEvaluated:false},
    });
    return conditions;
  }
  let candidates, scanComplete = true;
  function load() {
    if (candidates) return candidates;
    candidates = [];
    // Target index, not a scan of every unit/upgrade. Re-check the reference
    // against the visible field overlay so removals/retargets are not resurrected.
    const refs = db.prepare(`SELECT source_catalog,source_object_id,field_path FROM object_references
      WHERE target_catalog=? AND target_object_id=? AND source_catalog='Upgrade'
      ORDER BY source_object_id,field_path LIMIT ?`).all(catalog, objectId, SCAN_LIMIT + 1);
    scanComplete = refs.length <= SCAN_LIMIT;
    const seen = new Set();
    for (const ref of refs.slice(0, SCAN_LIMIT)) {
      const fs = fields('Upgrade', ref.source_object_id), f = pick(fs, ref.field_path);
      const match = f && /^EffectArray(?:\[([^\]]+)\])?\.Reference$/.exec(canonical(f.path));
      if (!match) continue;
      const [targetCatalog, targetId, ...rest] = f.value.split(',');
      if (targetCatalog !== catalog || targetId !== objectId || !rest.length) continue;
      const stem = canonical(f.path).replace(/\.Reference$/, '');
      const operand = pick(fs, stem + '.Value') ?? pick(fs, stem);
      const operation = pick(fs, stem + '.Operation');
      const key = JSON.stringify([ref.source_object_id, stem, rest.join(',')]);
      if (seen.has(key)) continue;
      seen.add(key);
      const object = db.prepare("SELECT is_default,parent_id FROM catalog_objects WHERE catalog='Upgrade' AND object_id=?").get(ref.source_object_id);
      candidates.push({ kind: 'upgrade-reference', targetPath: canonical(rest.join(',')),
        catalog: 'Upgrade', objectId: ref.source_object_id, template: Boolean(object?.is_default),
        operation: operation?.value ?? null, operand: operand?.value ?? null,
        reference: source('Upgrade', ref.source_object_id, f),
        parameter: operand ? source('Upgrade', ref.source_object_id, { ...operand, path: canonicalEditPath('CUpgrade', operand.path) }) : null,
        ...(operation ? { operationSource: source('Upgrade', ref.source_object_id, operation) } : {}),
        gaps: [...(!operation ? ['Operation 未显式声明；默认运算未在这里验证，不据此计算最终值。'] : []), ...(!operand ? ['参数缺失或存在歧义。'] : [])],
      });
    }
    if (catalog === 'Unit') {
      const behaviorFields = fields(catalog, objectId).filter(f => f.path.startsWith('BehaviorArray'));
      const slots = projectUnitArrayFields(behaviorFields.map(f => ({ ...f, path: f.path.replace(/^BehaviorArray/, 'AbilArray') }))).abilities.slots;
      const attachments = slots.map(slot => behaviorFields.find(f => f.value === slot.attributes.Link && slot.sourcePaths.includes(f.path.replace(/^BehaviorArray/, 'AbilArray')))).filter(Boolean);
      for (const attachment of attachments) {
        if (!db.prepare("SELECT 1 FROM catalog_objects WHERE catalog='Behavior' AND object_id=?").get(attachment.value)) continue;
        for (const f of fields('Behavior', attachment.value)) {
          const m = /^Modification\.Vital(Max(?:Array|FractionArray|AdditiveMultiplierArray)|Regen(?:Array|Multiplier))\[(Life|Shields|Energy)\]$/.exec(canonical(f.path));
          if (!m || !numeric(f.value)) continue;
          const targetPath = m[1].startsWith('Max') ? `${m[2]}Max` : `${m[2] === 'Shields' ? 'Shield' : m[2]}RegenRate`;
          const key = `behavior/${attachment.value}/${canonical(f.path)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ kind: 'attached-behavior-vital', targetPath, catalog: 'Behavior', objectId: attachment.value,
            operation: null, operand: f.value, parameter: source('Behavior', attachment.value, f), attachment: source('Unit', objectId, attachment),
            gaps: ['行为启用、层数、持续时间及 Modifier 组合语义未求值。'] });
        }
      }
    }
    return candidates;
  }
  const nextQuery = (path, offset = 0, limit = 8) => ({ ...root, topic: 'influences', ...(path ? { path } : {}), offset, limit });
  const activationCache = new Map();
  const activation = c => {
    const key = JSON.stringify([c.catalog,c.objectId]);
    if (!activationCache.has(key)) {
      const linked = c.catalog==='Upgrade' ? [...(conditionMap().get(c.objectId)??[])] : [];
      if (c.template) for (const child of researchRoutes.children(c.objectId).slice(0,8))
        linked.push(...(conditionMap().get(child.object_id)??[]).map(x=>({...x,viaUpgrade:child.object_id})));
      activationCache.set(key,classifyActivation({conditions:linked,
        research:researchRoutes.forCandidate(c),template:c.template,behavior:c.catalog==='Behavior',
      }));
    }
    return activationCache.get(key);
  };
  const activationCounts = all => {
    const counts = {};
    for (const c of all) { const key=activation(c).kind; counts[key]=(counts[key]??0)+1; }
    return counts;
  };
  function materialize(c, full) {
    const conditions = c.catalog === 'Upgrade' ? conditionMap().get(c.objectId) ?? [] : [];
    const when = activation(c);
    const result = { kind: c.kind, objectId: c.objectId, name: title(c.catalog, c.objectId), targetPath: c.targetPath,
      operation: c.operation, operand: c.operand, template: c.template ?? false,
      activation: full ? when : {kind:when.kind,unitTaskRole:when.unitTaskRole},
      operationStatus: c.operation ? 'explicit' : c.kind === 'upgrade-reference' ? 'default-unverified' : 'behavior-composition-not-evaluated',
      conditions: conditions.slice(0, full ? 8 : 2).map(condition=>{
        if(full)return condition;
        const {grantRoute,...summary}=condition; return summary;
      }), conditionsTruncated: conditions.length > (full ? 8 : 2), activationVerified: false,
      nextQuery: query(c.catalog, c.objectId, c.parameter?.path),
      ...(c.catalog==='Upgrade'?{effectsQuery:{...query('Upgrade',c.objectId),topic:'upgradeEffects',reference:{catalog,objectId,path:c.targetPath}}}:{}) };
    if (!full) return result;
    const research = c.catalog === 'Upgrade' ? researchRoutes.direct(c.objectId) : {entries:[],complete:true};
    const inheritors = c.template ? researchRoutes.children(c.objectId) : [];
    return { ...result, reference: c.reference, parameter: c.parameter, operationSource: c.operationSource, attachment: c.attachment,
      researchEntrypoints: research.entries,
      researchTruncated: !research.complete,
      ...(c.template ? { inheritedBy: { status: 'parent-link-candidates-not-evaluated', entries: inheritors.slice(0, 8).map(r => {
        const routes=researchRoutes.direct(r.object_id);
        return { objectId:r.object_id, nextQuery:query('Upgrade',r.object_id), researchEntrypoints:routes.entries.slice(0,2), researchTruncated:!routes.complete||routes.entries.length>2 };
      }), truncated: inheritors.length > 8 } } : {}),
      gaps: [...c.gaps, ...(!conditions.length ? ['未确认指挥官/等级/威望条件；不代表无条件激活。'] : []), ...(c.template ? ['模板不是可直接授予的升级；子级数组合并及实际研究入口需分别确认。'] : [])] };
  }
  function matching(path) {
    const matches = load().filter(c => !path || c.targetPath === canonical(path));
    // Startup context first, unresolved second, player research as reference.
    if (matches.some(c => c.catalog === 'Upgrade')) conditionMap();
    const priority = c => ({'startup-context':0,'unresolved-context':1,'reference-only':2})[activation(c).unitTaskRole];
    return matches.sort((a, b) => priority(a)-priority(b) || Number((conditions?.get(b.objectId) ?? []).some(c => c.selectedCommanderMatches)) - Number((conditions?.get(a.objectId) ?? []).some(c => c.selectedCommanderMatches)) || a.objectId.localeCompare(b.objectId) || a.targetPath.localeCompare(b.targetPath));
  }
  function read({ path, offset = 0, limit = 8 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid influence pagination');
    const all = matching(path);
    return { ...INFLUENCE_BOUNDARY, target: { catalog, objectId, ...(path ? { path } : {}) },
      coverage: { upgradeReferences: 'indexed-current-catalog', referenceScanComplete: scanComplete,
        activationSources:'typed-config-reviewed-B97579-rules-and-current-research-commands', grantSourceExclusivity:'not-proven',
        behaviors: catalog === 'Unit' ? 'attached-vital-fields-only' : 'not-analyzed',
        inheritedUpgradeComposition: 'not-evaluated', dynamicScripts: 'not-analyzed', externalAurasAndBuffs: 'not-analyzed',
        activationOrder: 'not-evaluated', complete: false },
      total: all.length, totalIsLowerBound: !scanComplete, activationCounts:activationCounts(all), offset, entries: all.slice(offset, offset + limit).map(c => materialize(c, true)),
      nextOffset: offset + limit < all.length ? offset + limit : null,
      ...(offset + limit < all.length ? { nextQuery: nextQuery(path, offset + limit, limit) } : {}) };
  }
  function summary(path) {
    const all = matching(path);
    const primary = all.filter(c=>activation(c).unitTaskRole!=='reference-only');
    return { basis: INFLUENCE_BOUNDARY.influenceBasis, coverageComplete: false,
      total: all.length, totalIsLowerBound: !scanComplete, activationCounts:activationCounts(all),
      preview: primary.slice(0, 2).map(c => materialize(c, false)),
      researchReferenceCount:all.length-primary.length,
      truncated: all.length > Math.min(primary.length,2), nextQuery: nextQuery(path) };
  }
  return { read, summary, boundary: INFLUENCE_BOUNDARY };
}
