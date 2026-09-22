import { FIELD_USAGE_INDEX_VERSION, fieldAccesses, indexGalaxyCatalogAccesses } from '../../../scripts/lib/field-usage-index.mjs';

const RAYNOR_UPGRADE = 'MasteryRaynorResearchCost';
const RAYNOR_PARAMETER = Object.freeze({
  catalog: 'Effect',
  objectId: 'GameARaynorResearchCostPerPoint',
  path: 'Amount',
});

const INDEX_CACHE = new WeakMap();

const REVIEWED_MECHANISMS = [
  {
    target: ['Effect', 'AvengingProtocolAttackSpeedDummy', 'Amount'],
    discovery: [['Behavior', 'FenixChampionSwapBoost'], ['Button', 'CommanderFenixChampionTransferBuff']],
    build: 'B97579', function: 'libCOMI_gf_CM_Fenix_AvengingProtocol',
    role: 'avenging-protocol-attack-speed-per-stack-input',
    summary: 'The script reads Amount as the attack-speed haste coefficient for each active Avenging Protocol stack.',
    formula: 'Behavior.Modification.AttackSpeedMultiplier = 1 + activeStacks * Amount',
    condition: 'FenixChampionSwapBoost researched; active stacks are capped by the champion group limit.',
    preserves: ['AvengingProtocolMoveSpeedDummy.Amount', 'movement-speed multiplier path'],
  },
  {
    target: ['Effect', 'VoidShardACDeathGripDamageDummy', 'Amount'],
    build: 'B97579', function: 'libCOMI_gt_VoidACShardModifyHealth_Func',
    role: 'runtime-computed-damage-output',
    summary: 'The trigger overwrites Amount immediately before executing the damage effect.',
    formula: 'Amount = 0.75 * (target current life + target current shields)',
    warning: 'A static Amount edit does not change the 75% damage ratio and cannot be reported as that gameplay change.',
  },
  {
    target: ['Effect', 'GameAMengskRoyalGuardBaseSupportPerSupply', 'Amount'],
    discovery: [['Effect', 'RoyalGuardMengskTopbarRegenDummy']],
    build: 'B97579', function: 'libCOMI_gf_CM_Mengsk_GlobalCasterEnergyRegenCalculateRoyalGuard',
    role: 'royal-guard-extra-base-support-per-living-supply',
    summary: 'Map Runtime adds this base term per living Royal Guard supply, while retaining the official rank-weighted coefficient.',
    formula: 'support = masteryFactor * (officialCoefficient * supply * (1 + rank) + basePerSupply * supply)',
    condition: 'TerranMengsk commander level is at least 5; only living Royal Guard units owned by the player contribute.',
    preserves: ['official SupplyLevel rank term', 'mastery factor', 'trooper contribution', 'non-Mengsk players'],
  },
];

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function indexSignature(db) {
  const build = db.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value ?? null;
  if (!tableExists(db, 'galaxy_files')) return JSON.stringify([FIELD_USAGE_INDEX_VERSION, build, []]);
  const sources = db.prepare('SELECT source_file,sha256,length(contents) AS bytes FROM galaxy_files ORDER BY source_file').all();
  return JSON.stringify([FIELD_USAGE_INDEX_VERSION, build, sources]);
}

function sharedAccessIndex(db) {
  const signature = indexSignature(db);
  let cached = INDEX_CACHE.get(db);
  if (!cached || cached.signature !== signature) {
    const files = tableExists(db, 'galaxy_files')
      ? db.prepare('SELECT source_file,sha256,contents FROM galaxy_files ORDER BY source_file').all() : [];
    cached = { signature, accesses: indexGalaxyCatalogAccesses(files), builds: (cached?.builds ?? 0) + 1 };
    INDEX_CACHE.set(db, cached);
  }
  return cached;
}

export function fieldUsageIndexStats(db) {
  const cached = INDEX_CACHE.get(db);
  return { parserVersion: FIELD_USAGE_INDEX_VERSION, builds: cached?.builds ?? 0, cached: Boolean(cached) };
}

function reviewedMechanism(db, catalog, objectId, path, matches) {
  const build = db.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value ?? null;
  const rule = REVIEWED_MECHANISMS.find(item => item.build === build
    && item.target[0] === catalog && item.target[1] === objectId && item.target[2].replaceAll('.@', '.') === String(path).replaceAll('.@', '.'));
  if (!rule) return null;
  const source = matches.find(item => item.function === rule.function);
  if (!source) return null;
  const { target: _target, discovery: _discovery, build: _build, function: expectedFunction, ...meaning } = rule;
  return { ...meaning, evidence: { kind: 'reviewed-source-mechanism', sc2DataBuild: build,
    function: expectedFunction, sourceFile: source.sourceFile, sourceSha256: source.sourceSha256, line: source.line } };
}

function raynorOfficialMechanism(db) {
  const build = db.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value;
  if (build !== 'B97579') return null;
  if (!tableExists(db, 'galaxy_files')) return null;
  const row = db.prepare("SELECT source_file,sha256,contents FROM galaxy_files WHERE lower(source_file) LIKE '%libcomi.galaxy' ORDER BY source_file LIMIT 1").get();
  if (!row) return null;
  const body = /void\s+libCOMI_gf_CM_RaynorUpgradeResearchCost\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(row.contents)?.[1];
  if (!body || !body.includes('IntToFixed(lp_level)*0.02') || !body.includes('AffectedUnitArray')
    || !body.includes('CeilingI((lv_default*lv_changedFactor))')) return null;
  const line = row.contents.slice(0, row.contents.indexOf('void libCOMI_gf_CM_RaynorUpgradeResearchCost')).split('\n').length;
  return { sourceFile: row.source_file, sourceSha256: row.sha256, line,
    function: 'libCOMI_gf_CM_RaynorUpgradeResearchCost', baselinePerPoint: 0.02 };
}

export function createFieldUsageReader(db, { inspect, dependencies }) {
  const accesses = () => sharedAccessIndex(db).accesses;
  const current = target => {
    try {
      const state = inspect(target.catalog, target.objectId, target.path);
      const edit = state.edit;
      return { value: state.commanderPatch?.value ?? state.coreCatalog?.value ?? null,
        edit: { available: edit.available, operation: edit.operation,
          ...(edit.available ? { expect: edit.expect, requiredDependsOn: dependencies(edit.operation) }
            : { reason: edit.reason }) } };
    } catch (error) {
      return { value: null, edit: { available: false, reason: error.message } };
    }
  };
  return {
    forObject(catalog, objectId) {
      const build = db.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value ?? null;
      return REVIEWED_MECHANISMS.filter(rule => rule.build === build
        && rule.discovery?.some(([ownerCatalog, ownerId]) => ownerCatalog === catalog && ownerId === objectId))
        .map(rule => {
          const [targetCatalog, targetObjectId, targetPath] = rule.target;
          const evidence = this.forField(targetCatalog, targetObjectId, targetPath);
          return { role: rule.role, summary: rule.summary,
            ...(rule.formula?{formula:rule.formula}:{}),...(rule.condition?{condition:rule.condition}:{}),
            ...(rule.preserves?{preserves:rule.preserves}:{}),
            target: { catalog: targetCatalog, objectId: targetObjectId, path: targetPath },
            nextQuery:{operation:'entity.get',catalog:targetCatalog,objectId:targetObjectId,path:targetPath},
            usageEvidence: evidence };
        });
    },
    forField(catalog, objectId, path, extra = {}) {
      const matches = fieldAccesses(accesses(), catalog, objectId, path);
      const readers = matches.filter(item => item.direction === 'read');
      const writers = matches.filter(item => item.direction === 'write');
      const uses = [];
      if (extra.display) uses.push('display');
      if (readers.length) uses.push('script-input');
      if (writers.length) uses.push('script-output');
      const dynamicCandidates = accesses().filter(item => !item.exact && item.catalog === catalog
        && (item.path === path || item.path === null));
      const mechanism = reviewedMechanism(db, catalog, objectId, path, matches);
      return { uses: uses.length ? uses : ['unidentified'],
        basis: [...(extra.display ? ['confirmed-tooltip-reference'] : []),
          ...(matches.length ? ['direct-galaxy-access'] : []),
          ...(!matches.length && !extra.display ? ['not-yet-identified'] : [])],
        ...(readers.length ? { readers } : {}), ...(writers.length ? { writers } : {}),
        ...(matches.length ? { sourceQueries:[...new Set(matches.map(item=>item.function).filter(Boolean))].slice(0,8)
          .map(query=>({operation:'galaxy.context',query,detailLevel:'full',limit:3})) } : {}),
        ...(mechanism ? { mechanism } : {}),
        coverage: { officialExtractedSource: 'indexed', gameASource: 'not-indexed', complete: false,
          dynamicAccesses: dynamicCandidates.length,
          note: 'Direct literal Catalog accesses in the official extracted source are indexed. Dynamic arguments and Map Runtime project scripts are not proof of absence.' },
        validity: { sc2DataBuild: db.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value ?? null,
          parserVersion: FIELD_USAGE_INDEX_VERSION, evidenceKind: 'local-extracted-source' } };
    },
    forMastery(upgradeId) {
      if (upgradeId !== RAYNOR_UPGRADE) return null;
      const official = raynorOfficialMechanism(db);
      if (!official) return { status: 'unconfirmed', gap: 'The applicable Raynor research-cost function was not resolved in the local source index.' };
      const parameter = current(RAYNOR_PARAMETER);
      return { status: parameter.edit.available ? 'supported' : 'gameplay-path-pending',
        summary: 'The Upgrade operand is tooltip display data. Actual research costs are calculated from mastery level and a separate per-point coefficient.',
        official: { ...official, formula: 'ceil(baseCost * (1 - masteryLevel * perPoint))',
          baseCostSource: 'c_playerAny', affectedResearchSource: 'Upgrade.AffectedUnitArray' },
        implementation: { kind: 'game-a-script-parameter', target: RAYNOR_PARAMETER,
          currentValue: parameter.value, edit: parameter.edit,
          source: 'Base.SC2Data/Generated/RaynorResearchCost.galaxy',
          application: 'the host post-mission-startup callback, after the official Raynor formula',
          preserves: ['AffectedUnitArray research list', 'four resource slots', 'CeilingI rounding', 'unmodified c_playerAny base costs'] },
        ...(parameter.edit.available ? {} : { gap: 'The Map Runtime Raynor research-cost parameter is not available in this project.' }) };
    },
  };
}
