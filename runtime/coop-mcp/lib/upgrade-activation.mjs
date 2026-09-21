// Static grant-route evidence, NOT runtime activation or an exclusivity proof.
// B97579 rules were checked against the installed libcooc.galaxy startup path.
const STARTUP_RULE_BUILD = 'B97579';
export const UNIT_INFLUENCE_POLICY = {
  focus: 'startup-before-player-research',
  research: 'reference-only-unless-requested',
  note: '单位修改默认关注开局、未进行局内研究的数值。玩家研究保留原样，后续联动属于另一个改升级任务，除非用户明确要求一并修改；不因此阻止提交。未知来源不等于开局激活，也不要求遍历全图。',
};

export function profileGrantRoute(build, kind, link = {}) {
  if (build !== STARTUP_RULE_BUILD) return null;
  let fn;
  if (kind === 'defaultUpgrades') fn = 'libCOOC_gf_CC_ApplyCommanderTech';
  if (kind === 'levelPerks' && link.fieldId === 'Upgrade') fn = 'libCOOC_gf_EnableDisableCampaignPerk';
  if (kind === 'masteries' && link.fieldId === 'Upgrade') fn = 'libCOOC_gf_CC_ApplyMasteryTech';
  if (kind === 'prestiges' && ['primary-prestige-upgrade','secondary-prestige-upgrade','conditional-prestige-supplement'].includes(link.role)) fn = 'libCOOC_gf_CC_PlayerPrestigeEnable';
  if (!fn) return null; // Reviewed navigation/UpgradeOff/research unlock is not a grant.
  return {
    kind: link.role === 'conditional-prestige-supplement' ? 'conditional-automatic' : 'startup-automatic',
    basis: 'typed-config-and-reviewed-startup-rule', reviewedBuild: STARTUP_RULE_BUILD,
    sourceFile: 'starcoop.sc2mod:base.sc2data/libcooc.galaxy', function: fn,
    conditionsEvaluated: false,
  };
}

export function classifyActivation({ conditions, research, template, behavior = false }) {
  // A different commander's self-only grant does not make this commander's
  // research automatic. Shared grants remain candidates; ally identity unknown.
  const relevant = conditions.filter(c => c.selectedCommanderMatches !== false || c.recipientScope === 'commander-players');
  const grants = relevant.filter(c => c.grantRoute);
  const startup = grants.some(c => c.grantRoute.kind === 'startup-automatic');
  const conditional = grants.some(c => c.grantRoute.kind === 'conditional-automatic');
  const hasResearch = research.entries.length > 0;
  const kind = (startup || conditional) && hasResearch ? 'mixed'
    : startup ? 'startup-automatic' : conditional ? 'conditional-automatic'
    : hasResearch ? 'player-research' : 'unknown';
  const labels = { 'startup-automatic':'开局自动修正（条件未求值）', 'conditional-automatic':'条件自动触发（时机未知）',
    mixed:'自动授予与研究入口并存', 'player-research':'局内研究入口（参考）', unknown:'生效来源/时机未知' };
  return { kind, label: labels[kind], activationVerified: false, exclusive: false,
    unitTaskRole: kind === 'player-research' ? 'reference-only' : startup ? 'startup-context' : 'unresolved-context',
    evidence: grants.slice(0, 2).map(c => ({ ...c.grantRoute, commanderId: c.commanderId, entryId: c.entryId,
      recipientScope: c.recipientScope ?? 'self', ...(c.viaUpgrade?{viaUpgrade:c.viaUpgrade}:{}) })), evidenceTruncated: grants.length > 2,
    ...(hasResearch ? { researchVia: research.entries.slice(0,1), researchEvidenceComplete: research.complete,
      note: template ? '子级存在研究入口；模板合并未求值，不把模板当作已激活科技。'
        : '确认存在研究入口，不证明只能研究获得或该命令当前可用；单位修改默认不适配研究后结果。' }
      : kind === 'unknown' ? { note: behavior ? '挂载 Behavior 不证明开局已启用。' : '没有足够的授予入口证据；名称或导航关联不作为开局生效依据。' } : {}),
  };
}

// Typed, current research commands; revalidate reverse links against visible
// fields so cleared/retargeted commands cannot survive as false evidence.
export function createResearchRouteReader(db, { fields, pick, canonical, query }) {
  const cache = new Map(), childCache = new Map();
  function direct(id) {
    if (cache.has(id)) return cache.get(id);
    const rows = db.prepare(`SELECT r.source_object_id,r.field_path FROM object_references r
      JOIN catalog_objects a ON a.catalog='Abil' AND a.object_id=r.source_object_id
      WHERE r.target_catalog='Upgrade' AND r.target_object_id=? AND r.source_catalog='Abil' AND a.class='CAbilResearch'
      ORDER BY r.source_object_id,r.field_path LIMIT 129`).all(id);
    const entries = [], seen = new Set();
    for (const r of rows.slice(0,128)) {
      const p = canonical(r.field_path), match = /^InfoArray\[([^\]]+)\]\.Upgrade$/.exec(p);
      if (!match || pick(fields('Abil',r.source_object_id),r.field_path)?.value !== id) continue;
      const key = JSON.stringify([r.source_object_id,match[1]]);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ upgradeId:id, abilityId:r.source_object_id, path:r.field_path,
        conditionStatus:'research-command-requirements-not-evaluated',
        nextQuery:{...query('Abil',r.source_object_id),commandIndex:match[1]} });
    }
    const result = {entries:entries.slice(0,8),complete:rows.length<=128 && entries.length<=8};
    cache.set(id,result); return result;
  }
  function children(id) {
    if (!childCache.has(id)) childCache.set(id,db.prepare("SELECT object_id FROM catalog_objects WHERE catalog='Upgrade' AND parent_id=? ORDER BY object_id LIMIT 9").all(id));
    return childCache.get(id);
  }
  function forCandidate(c) {
    if (c.catalog !== 'Upgrade') return {entries:[],complete:true};
    const own = direct(c.objectId);
    if (!c.template) return own;
    const kids = children(c.objectId), entries = [...own.entries];
    let complete = own.complete && kids.length <= 8;
    for (const kid of kids.slice(0,8)) {
      const child = direct(kid.object_id); complete &&= child.complete;
      entries.push(...child.entries.map(e=>({...e,viaTemplate:c.objectId})));
    }
    return {entries:entries.slice(0,8),complete:complete && entries.length<=8};
  }
  return {direct,children,forCandidate};
}
