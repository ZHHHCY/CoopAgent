import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(value).digest('hex');
const affirmative = text => String(text ?? '').split(/[；;。，,\n]/)
  .filter(clause => !/不要|不改|不影响|保持|不变|do not|don't|unchanged/i.test(clause)).join('\n');
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function commanderAliases(db) {
  if (!tableExists(db, 'commanders')) return [];
  const columns = new Set(db.prepare('PRAGMA table_info(commanders)').all().map(row => row.name));
  const available = ['id', 'commander_object_id', 'name_zhcn', 'name_enus'].filter(name => columns.has(name));
  if (!available.length) return [];
  return db.prepare(`SELECT ${available.join(',')} FROM commanders`).all().flatMap(row => available
    .filter(name => typeof row[name] === 'string' && row[name].trim().length >= 2)
    .flatMap(name => {
      const alias = row[name].trim();
      // Common Chinese localizations sometimes include a final transliterated
      // syllable that players omit (for example 凯拉克斯 → 凯拉克). Keep the
      // candidate database-backed and require at least three Han characters.
      const short = name === 'name_zhcn' && /[\u3400-\u9fff]{4,}$/.test(alias) ? alias.slice(0, -1) : null;
      return [alias, short].filter(Boolean).map(value => ({ commanderId: row.id ?? row.commander_object_id, alias: value }));
    }))
    .filter(item => item.commanderId);
}

function containsAlias(text, alias) {
  if (/^[a-z0-9_-]+$/i.test(alias)) return new RegExp(`(^|[^a-z0-9_-])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i').test(text);
  return text.includes(alias);
}

function latestExplicit(messages, read) {
  for (const message of [...messages].reverse()) {
    const value = read(affirmative(message.text));
    if (value.length) return { values: [...new Set(value)], source: { turnId: message.turnId ?? null,
      messageSha256: hash(String(message.text)), source: 'user' } };
  }
  return { values: [], source: null };
}

export function deriveRequestBinding({ databaseFile, messages = [] } = {}) {
  const normalized = messages.filter(message => typeof message?.text === 'string' && message.text.trim());
  let aliases = [];
  if (databaseFile) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try { aliases = commanderAliases(db); } finally { db.close(); }
  }
  const commanders = latestExplicit(normalized, text => aliases.filter(item => containsAlias(text, item.alias)).map(item => item.commanderId));
  const planes = latestExplicit(normalized, text => [
    /对地|地面(?:单位|目标)|\bground(?:-only|\s+targets?)?\b/i.test(text) ? 'ground' : null,
    /对空|空中(?:单位|目标)|\bair(?:-only|\s+targets?)?\b/i.test(text) ? 'air' : null,
  ].filter(Boolean));
  const global = latestExplicit(normalized, text => /所有指挥官|全部指挥官|全局|\ball commanders\b|\bevery commander\b/i.test(text) ? ['global'] : []);
  const activationTiming = latestExplicit(normalized, text =>
    /(?:原版|官方)?威望(?:升级)?(?:应用|授予|生效)(?:完成)?后|after\s+(?:the\s+)?(?:original|official)?\s*prestige(?:\s+upgrade)?\s+(?:is\s+)?(?:applied|granted|active)/i.test(text)
      ? ['after-official-prestige-application'] : []);
  const activationProof = latestExplicit(normalized, text =>
    /只有[^；;。\n]*(?:证明|确认)[^；;。\n]*才(?:提交|应用)|(?:submit|apply)\s+only\s+if[^.;\n]*(?:prov|verif)/i.test(text)
      ? ['required'] : []);
  const preservedPrestigeRelation = latestExplicit(normalized, text => {
    const match = text.match(/(?:同步)?(?:保留|保持)[^；;。\n]*?P([123])[^；;。\n]*?(?:派生|比例|关系|减免)|P([123])[^；;。\n]*?(?:派生|比例|关系|减免)[^；;。\n]*?(?:保留|保持)/i);
    return match ? [Number(match[1] ?? match[2])] : [];
  });
  const masteryScalingChoice = latestExplicit(normalized, text => [
    /保留[^；;。\n]*(?:不同单位|单位之间|原来|原有)[^；;。\n]*(?:比例|关系)|(?:比例|关系)[^；;。\n]*保留/.test(text) ? 'preserve-ratio' : null,
    /所有[^；;。\n]*(?:战斗)?单位[^；;。\n]*统一[^；;。\n]*(?:每点)?|统一[^；;。\n]*(?:所有|全部)[^；;。\n]*(?:战斗)?单位/.test(text) ? 'uniform' : null,
  ].filter(Boolean));
  const masteryRateRequested = normalized.some(message => /精通/.test(affirmative(message.text)));
  const scalarTarget = latestExplicit(normalized, text =>
    /统和屏障[^；;。\n]*基础冷却|基础冷却[^；;。\n]*统和屏障/.test(text)
      ? ['Behavior\0KaraxUnitSpawnBarrierDisabled\0Duration'] : []);
  const lastUserText = normalized.at(-1)?.text ?? '';
  const declinedChange = normalized.length > 1 && /(?:暂不|先不|不要|取消)(?:再)?(?:修改|改动|提交)|(?:no|do not)\s+(?:change|apply)/i.test(lastUserText);
  return { version: 1,
    scope: commanders.values.length ? { kind: 'commander', commanderIds: commanders.values, source: commanders.source }
      : global.values.length ? { kind: 'global', source: global.source } : null,
    effectPlanes: planes.values,
    effectPlaneSource: planes.source,
    condition: activationTiming.values.length ? {
      activationTiming: activationTiming.values[0],
      proofRequired: activationProof.values.length > 0,
      source: activationTiming.source,
    } : null,
    preservedPrestigeRelation: preservedPrestigeRelation.values.length ? {
      displayIndex: preservedPrestigeRelation.values[0], source: preservedPrestigeRelation.source,
    } : null,
    masteryRateRequested,
    masteryScalingChoice: masteryScalingChoice.values[0] ?? null,
    scalarTarget: scalarTarget.values.length ? {
      catalog: 'Behavior', object: 'KaraxUnitSpawnBarrierDisabled', path: 'Duration',
      conflictPrestigeIndex: 1, source: scalarTarget.source,
    } : null,
    declinedChange: declinedChange ? { source: { turnId: normalized.at(-1)?.turnId ?? null,
      messageSha256: hash(lastUserText), source: 'user' } } : null,
    sourceMessages: normalized.map(message => ({ turnId: message.turnId ?? null,
      messageSha256: hash(message.text), source: 'user' })) };
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const canonical = value => String(value ?? '').replaceAll('.@', '.').toLowerCase();

function cloneSources(plan) {
  return new Map((plan.operations ?? []).filter(op => op.kind === 'catalog.clone')
    .map(op => [`${String(op.catalog).toLowerCase()}\0${String(op.object).toLowerCase()}`, op.source]));
}

function sourceObject(clones, catalog, object) {
  let current = object;
  for (let depth = 0; depth < 12; depth++) {
    const next = clones.get(`${String(catalog).toLowerCase()}\0${String(current).toLowerCase()}`);
    if (!next || same(next, current)) break;
    current = next;
  }
  return current;
}

function targetFromUpgrade(db, object, path) {
  const referencePath = String(path).replace(/\.?@?Value$/i, '.Reference');
  const row = db.prepare(`SELECT value FROM catalog_fields WHERE lower(catalog)='upgrade' AND lower(object_id)=lower(?)
    AND lower(replace(path,'.@','.'))=lower(?) LIMIT 1`).get(object, canonical(referencePath));
  if (!row?.value) return null;
  const [catalog, target, ...field] = row.value.split(',');
  return catalog && target ? { catalog, object: target, path: field.join(',') } : null;
}

function operationTarget(db, operation, clones) {
  let catalog = operation.catalog, object = operation.object;
  if (!catalog || !object) return null;
  object = sourceObject(clones, catalog, object);
  if (same(catalog, 'Upgrade') && /EffectArray/i.test(operation.path ?? '')) {
    return targetFromUpgrade(db, object, operation.path) ?? { catalog, object, unknownCombatTarget: true };
  }
  return { catalog, object, path: operation.path };
}

function validateHeterogeneousMasteryRate(plan, binding, databaseFile) {
  if (!binding?.masteryRateRequested || !databaseFile) return;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const clones = cloneSources(plan), groups = new Map();
    for (const operation of plan.operations ?? []) {
      if (!scalarOperation(operation) || !same(operation.catalog, 'Upgrade') || !/EffectArray/i.test(operation.path ?? '')) continue;
      const target = operationTarget(db, operation, clones);
      if (!target || !same(target.catalog, 'Weapon') || !/RateMultiplier/i.test(target.path ?? '')) continue;
      const values = groups.get(operation.object) ?? [];
      values.push(operation); groups.set(operation.object, values);
    }
    for (const operations of groups.values()) {
      if (new Set(operations.map(operation => Number(operation.expect))).size < 2) continue;
      if (!binding.masteryScalingChoice) {
        throw Error('REQUEST_MASTERY_SCALING_CONFIRMATION_REQUIRED: this mastery has different existing per-unit rate multipliers. '
          + 'Before preparing a plan, explain the player-visible choices and use target_confirm to ask whether to preserve their existing ratios '
          + 'or make every affected combat unit use the same per-point rate.');
      }
      if (binding.masteryScalingChoice === 'preserve-ratio') {
        const ratios = operations.map(operation => Number(operation.value) / Number(operation.expect));
        if (ratios.some(value => !Number.isFinite(value)) || Math.max(...ratios) - Math.min(...ratios) > 1e-9) {
          throw Error('REQUEST_MASTERY_SCALING_MISMATCH: user chose to preserve existing per-unit ratios, but the proposed gameplay operands do not use one common scale factor.');
        }
      }
      if (binding.masteryScalingChoice === 'uniform'
        && new Set(operations.map(operation => Number(operation.value))).size !== 1) {
        throw Error('REQUEST_MASTERY_SCALING_MISMATCH: user chose one uniform per-point rate for every affected combat unit, but proposed gameplay operands still differ.');
      }
    }
  } finally { db.close(); }
}

function reverseWeapons(db, target) {
  if (same(target.catalog, 'Weapon')) return new Set([target.object]);
  if (!same(target.catalog, 'Effect') || !tableExists(db, 'object_references')) return new Set();
  const weapons = new Set(), pending = [{ catalog: 'Effect', object: target.object, depth: 0 }], seen = new Set();
  while (pending.length) {
    const item = pending.shift(), key = `${item.catalog}\0${item.object}`.toLowerCase();
    if (seen.has(key) || item.depth > 12) continue;
    seen.add(key);
    for (const row of db.prepare(`SELECT source_catalog AS catalog,source_object_id AS object
      FROM object_references WHERE lower(target_catalog)=lower(?) AND lower(target_object_id)=lower(?)`).all(item.catalog, item.object)) {
      if (same(row.catalog, 'Weapon')) weapons.add(row.object);
      else if (same(row.catalog, 'Effect')) pending.push({ ...row, depth: item.depth + 1 });
    }
  }
  return weapons;
}

function weaponPlanes(db, weaponId) {
  const row = db.prepare(`SELECT value FROM catalog_fields WHERE lower(catalog)='weapon' AND lower(object_id)=lower(?)
    AND lower(replace(path,'.@','.'))='targetfilters' LIMIT 1`).get(weaponId);
  const [includedRaw = '', excludedRaw = ''] = String(row?.value ?? '').split(';', 2);
  const included = new Set(includedRaw.split(',').map(value => value.trim().toLowerCase()));
  const excluded = new Set(excludedRaw.split(',').map(value => value.trim().toLowerCase()));
  const explicit = included.has('ground') || included.has('air');
  return new Set((explicit ? ['ground', 'air'].filter(value => included.has(value)) : ['ground', 'air'])
    .filter(value => !excluded.has(value)));
}

function unitCombatPlanes(db, unitId) {
  const weapons = db.prepare(`SELECT value FROM catalog_fields WHERE lower(catalog)='unit'
    AND lower(object_id)=lower(?) AND lower(replace(path,'.@','.')) LIKE 'weaponarray%.link'`).all(unitId);
  const planes = new Set();
  for (const row of weapons) for (const plane of weaponPlanes(db, row.value)) planes.add(plane);
  return planes;
}

function unresolvedSameNameCombatForms(evidence, db) {
  for (const item of evidence) {
    const output = item?.output;
    if (item?.input?.operation !== 'entity.resolve' || output?.resolved !== false) continue;
    const units = (output.candidates ?? []).filter(candidate => same(candidate.catalog, 'Unit'));
    const groups = new Map();
    for (const unit of units) {
      const displayName = String(unit.nameZhCN || unit.nameEnUS || '').trim().toLowerCase();
      if (!displayName) continue;
      const values = groups.get(displayName) ?? [];
      values.push({ objectId: unit.objectId, planes: unitCombatPlanes(db, unit.objectId) });
      groups.set(displayName, values);
    }
    for (const forms of groups.values()) {
      if (forms.length < 2) continue;
      const union = new Set(forms.flatMap(form => [...form.planes]));
      if (union.has('ground') && union.has('air')) return forms;
    }
  }
  return null;
}

function scalarOperation(operation) {
  return typeof operation.value === 'number' && typeof operation.expect === 'number';
}

function profilePrestigeId(db, commanderId, displayIndex) {
  if (!tableExists(db, 'commander_profiles')) return null;
  const row = db.prepare('SELECT profile_json FROM commander_profiles WHERE lower(commander_id)=lower(?) LIMIT 1').get(commanderId);
  if (!row?.profile_json) return null;
  try {
    const profile = JSON.parse(row.profile_json);
    const prestige = (profile.prestiges ?? []).find(item => Number(item.index) === Number(displayIndex) - 1);
    return prestige?.primaryUpgrade ?? prestige?.id ?? null;
  } catch { return null; }
}

function fieldValue(db, catalog, object, path) {
  const normalized = canonical(path);
  const scalarElement = normalized.replace(/\.value$/i, '');
  return db.prepare(`SELECT value FROM catalog_fields WHERE lower(catalog)=lower(?) AND lower(object_id)=lower(?)
    AND lower(replace(path,'.@','.')) IN (lower(?),lower(?))
    ORDER BY CASE WHEN lower(replace(path,'.@','.'))=lower(?) THEN 0 ELSE 1 END LIMIT 1`)
    .get(catalog, object, normalized, scalarElement, normalized)?.value;
}

function validatePreservedPrestigeRelation(plan, binding, databaseFile) {
  if (!binding?.preservedPrestigeRelation || !databaseFile || binding.scope?.kind !== 'commander') return;
  const commanderId = binding.scope.commanderIds?.[0];
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const displayIndex = binding.preservedPrestigeRelation.displayIndex;
    const prestigeId = profilePrestigeId(db, commanderId, displayIndex);
    if (!prestigeId) throw Error(`REQUEST_DERIVED_RELATION_UNRESOLVED: cannot resolve P${displayIndex} for ${commanderId}.`);
    for (const base of (plan.operations ?? []).filter(operation => operation.kind === 'commander.stat.set'
      && same(operation.commanderId, commanderId) && scalarOperation(operation) && !operation.prestigeUpgrade)) {
      const reference = `${base.catalog},${base.object},${base.path}`;
      const rows = db.prepare(`SELECT path FROM catalog_fields WHERE lower(catalog)='upgrade' AND lower(object_id)=lower(?)
        AND lower(value)=lower(?) AND lower(replace(path,'.@','.')) LIKE 'effectarray%.reference'`).all(prestigeId, reference);
      for (const row of rows) {
        const operationPath = row.path.replace(/\.?@?Reference$/i, '.@Operation');
        const valuePath = row.path.replace(/\.?@?Reference$/i, '.@Value');
        const modifierKind = fieldValue(db, 'Upgrade', prestigeId, operationPath) ?? 'Add';
        if (!['add', 'subtract'].includes(String(modifierKind).toLowerCase())) continue;
        const oldOperand = Number(fieldValue(db, 'Upgrade', prestigeId, valuePath));
        if (!Number.isFinite(oldOperand) || base.expect === 0) {
          throw Error(`REQUEST_DERIVED_RELATION_UNRESOLVED: ${prestigeId}.${valuePath} has no scalable numeric operand.`);
        }
        const expectedOperand = oldOperand * base.value / base.expect;
        const companion = (plan.operations ?? []).find(operation => operation.kind === 'catalog.set'
          && same(operation.catalog, 'Upgrade') && same(operation.object, prestigeId)
          && canonical(operation.path) === canonical(valuePath));
        const valid = companion && Number(companion.expect) === oldOperand
          && Math.abs(Number(companion.value) - expectedOperand) <= 1e-9;
        if (!valid) throw Error(`REQUEST_DERIVED_RELATION_MISMATCH: P${displayIndex} ${prestigeId}.${valuePath} `
          + `must change ${oldOperand} -> ${expectedOperand} with the base ${base.expect} -> ${base.value}; `
          + 'preserving Reference/Operation alone does not preserve the derived relation.');
      }
    }
  } finally { db.close(); }
}

function validateBoundScalarTarget(plan, binding, databaseFile) {
  const target = binding?.scalarTarget;
  if (!target) return;
  const scalar = (plan.operations ?? []).filter(scalarOperation);
  if (!scalar.length) return;
  const matches = scalar.filter(operation => same(operation.catalog, target.catalog)
    && same(operation.object, target.object) && canonical(operation.path) === canonical(target.path));
  if (!matches.length) {
    throw Error(`REQUEST_TARGET_MISMATCH: user requested ${target.catalog}/${target.object}.${target.path}; `
      + 'the plan changes a different scalar target.');
  }
  if (binding.preservedPrestigeRelation || binding.declinedChange || !databaseFile) return;
  const base = matches.find(operation => operation.kind === 'commander.stat.set'
    && !operation.prestigeUpgrade && scalarOperation(operation));
  const commanderId = binding.scope?.kind === 'commander' ? binding.scope.commanderIds?.[0] : null;
  if (!base || !commanderId) return;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const displayIndex = target.conflictPrestigeIndex, prestigeId = profilePrestigeId(db, commanderId, displayIndex);
    if (!prestigeId) return;
    const reference = `${target.catalog},${target.object},${target.path}`;
    const row = db.prepare(`SELECT path FROM catalog_fields WHERE lower(catalog)='upgrade' AND lower(object_id)=lower(?)
      AND lower(value)=lower(?) AND lower(replace(path,'.@','.')) LIKE 'effectarray%.reference' LIMIT 1`).get(prestigeId, reference);
    if (!row) return;
    const operationPath = row.path.replace(/\.?@?Reference$/i, '.@Operation');
    const valuePath = row.path.replace(/\.?@?Reference$/i, '.@Value');
    const modifierKind = String(fieldValue(db, 'Upgrade', prestigeId, operationPath) ?? 'Add').toLowerCase();
    const operand = Number(fieldValue(db, 'Upgrade', prestigeId, valuePath));
    if (!['add', 'subtract'].includes(modifierKind) || !Number.isFinite(operand) || base.expect === 0) return;
    const sign = modifierKind === 'subtract' ? -1 : 1;
    const oldDerived = base.expect + sign * operand, changedDerived = base.value + sign * operand;
    const preservedOperand = operand * base.value / base.expect;
    const preservedDerived = base.value + sign * preservedOperand;
    throw Error(`REQUEST_DERIVED_RELATION_CONFIRMATION_REQUIRED: P${displayIndex} ${prestigeId}.${valuePath} is a fixed `
      + `${modifierKind} ${operand}. Base ${base.expect} -> ${base.value} alone changes the derived result `
      + `${oldDerived} -> ${changedDerived}; preserving the existing ratio requires ${operand} -> ${preservedOperand} `
      + `and gives ${preservedDerived}. Explain this conflict and use target_confirm before preparing a plan.`);
  } finally { db.close(); }
}

export function validateRequestBinding(plan, binding, { databaseFile, evidence = [] } = {}) {
  if (binding?.declinedChange && (plan.operations ?? []).length) {
    throw Error('REQUEST_DECLINED_CHANGE: the user chose not to modify the project; no operations may be prepared or submitted.');
  }
  validateBoundScalarTarget(plan, binding, databaseFile);
  const requestedCommanders = binding?.scope?.kind === 'commander' ? binding.scope.commanderIds : [];
  if (requestedCommanders.length) {
    if (plan.scope?.kind === 'global' || plan.isolation?.strategy === 'global') {
      throw Error(`REQUEST_SCOPE_MISMATCH: user named ${requestedCommanders.join(', ')}; global scope/isolation is not authorized.`);
    }
    if (plan.scope?.kind !== 'commander') {
      throw Error(`REQUEST_SCOPE_MISMATCH: user named ${requestedCommanders.join(', ')}; the plan must retain commander scope.`);
    }
    if (!requestedCommanders.some(id => same(id, plan.scope.commanderId))) {
      throw Error(`REQUEST_COMMANDER_MISMATCH: plan commander ${plan.scope.commanderId ?? 'missing'} is not named by the user.`);
    }
    for (const operation of plan.operations ?? []) if (operation.commanderId
      && !requestedCommanders.some(id => same(id, operation.commanderId))) {
      throw Error(`REQUEST_COMMANDER_MISMATCH: ${operation.opId} changes ${operation.commanderId}, outside the user binding.`);
    }
  }

  if (binding?.effectPlanes?.length === 1 && databaseFile) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const clones = cloneSources(plan), actual = new Set(); let combatScalar = false;
      for (const operation of plan.operations ?? []) {
        if (!scalarOperation(operation)) continue;
        const target = operationTarget(db, operation, clones); if (!target) continue;
        if (!['weapon', 'effect', 'upgrade'].includes(String(target.catalog).toLowerCase())) continue;
        combatScalar = true;
        for (const weapon of reverseWeapons(db, target)) for (const plane of weaponPlanes(db, weapon)) actual.add(plane);
      }
      const requested = binding.effectPlanes[0], other = requested === 'ground' ? 'air' : 'ground';
      if (combatScalar && (!actual.has(requested) || actual.has(other))) {
        throw Error(`REQUEST_EFFECT_MISMATCH: user requested ${requested}; affected weapon evidence is ${actual.size ? [...actual].join('+') : 'unresolved'}.`);
      }
    } finally { db.close(); }
  }

  if (!binding?.effectPlanes?.length && databaseFile) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const ambiguousForms = unresolvedSameNameCombatForms(evidence, db);
      if (ambiguousForms) {
        const clones = cloneSources(plan), actual = new Set();
        for (const operation of plan.operations ?? []) {
          if (!scalarOperation(operation)) continue;
          const target = operationTarget(db, operation, clones); if (!target) continue;
          for (const weapon of reverseWeapons(db, target)) for (const plane of weaponPlanes(db, weapon)) actual.add(plane);
        }
        if (actual.size === 1) {
          throw Error('REQUEST_EFFECT_FORM_CONFIRMATION_REQUIRED: the unresolved unit name maps to same-name ground and air combat forms, '
            + `but this plan changes only ${[...actual][0]}. Compare both forms and their current requested operands; if the player intent `
            + 'still cannot be determined from the request, explain the gameplay difference and use target_confirm before preparing a plan.');
        }
      }
    } finally { db.close(); }
  }

  if (binding?.condition?.activationTiming === 'after-official-prestige-application') {
    const earlyGenerated = (plan.operations ?? []).filter(operation =>
      operation.kind === 'commander.stat.set' && operation.prestigeUpgrade);
    if (earlyGenerated.length) {
      throw Error(`REQUEST_CONDITION_TIMING_MISMATCH: user requires activation after the official prestige application; `
        + `${earlyGenerated.map(operation => operation.opId).join(', ')} uses the generated commander Upgrade path, whose configure hook runs before official commander tech.`);
    }
    const verifiedOrder = evidence.some(item => {
      const pending = [item.output];
      while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (value.activationVerified === true
          && value.activationOrder === 'after-official-prestige-application') return true;
        pending.push(...(Array.isArray(value) ? value : Object.values(value)));
      }
      return false;
    });
    if (binding.condition.proofRequired && !verifiedOrder) {
      throw Error('REQUEST_CONDITION_TIMING_UNPROVEN: user authorized submission only with verified post-prestige activation evidence; static scope matching is insufficient.');
    }
  }

  validatePreservedPrestigeRelation(plan, binding, databaseFile);
  validateHeterogeneousMasteryRate(plan, binding, databaseFile);

  const solverResults = evidence.filter(item => item.input?.operation === 'scalar.solve')
    .flatMap(item => item.output?.results ?? []);
  if (solverResults.some(result => result.status === 'already-at-target')) {
    const allowed = solverResults.filter(result => result.status === 'solved' && result.operation)
      .map(result => result.operation);
    for (const operation of plan.operations ?? []) {
      if (operation.kind !== 'commander.stat.set' || !scalarOperation(operation)) continue;
      const match = allowed.some(expected => ['kind', 'catalog', 'object', 'commanderId', 'prestigeUpgrade'].every(key => same(operation[key], expected[key]))
        && canonical(operation.path) === canonical(expected.path)
        && operation.expect === expected.expect && operation.value === expected.value);
      if (!match) throw Error(`REQUEST_ALREADY_SATISFIED: ${operation.opId} is not a solved requested target; do not change another scalar to manufacture a submission.`);
    }
  }
  return binding;
}
