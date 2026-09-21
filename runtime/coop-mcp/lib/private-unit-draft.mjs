import { createHash } from 'node:crypto';
import { operationTargets, targetsConflict } from '../../../scripts/lib/patch-plan-executor.mjs';

// Authoring expansion only. No game writes, new IR, inferred gameplay values or
// executor policy. Every generated change remains explicit in ordinary v2 ops.
export class PrivateDraftError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'PrivateDraftError'; this.details = details; }
}
const key = (catalog, objectId) => `${catalog}/${objectId}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const sorted = items => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
const pathKey = entry => `${key(entry.catalog, entry.objectId ?? entry.object)}/${entry.path}`;
const stable = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, 'en'))) : entry);

// Additive drafting: preserve the existing design byte-for-byte at operation
// level. Conflicting writes/removals/reordering require an explicit plan edit.
export function extendPrivateUnitDraft(existing, addition) {
  for (const field of ['id', 'formatVersion', 'target', 'compatibility', 'scope', 'isolation']) {
    if (stable(existing[field]) !== stable(addition[field])) throw new PrivateDraftError('Existing draft has a different identity, scope or baseline; revise it explicitly.', { field });
  }
  const operations = [...existing.operations];
  for (const operation of addition.operations) {
    const sameId = operations.find(op => op.opId === operation.opId);
    if (sameId) {
      if (stable(sameId) !== stable(operation)) throw new PrivateDraftError('Draft operation was already designed differently; use plan to revise it explicitly.', { opId: operation.opId });
      continue;
    }
    const targets = operationTargets(operation);
    const overridesFoundation = op => operation.kind === 'catalog.set' && (
      (op.kind === 'catalog.clone' && operation.catalog === op.catalog && operation.object === op.object)
      || (op.kind === 'commander.unit.clone' && ((operation.catalog === 'Unit' && operation.object === op.unitId)
        || (operation.catalog === 'Actor' && operation.object === (op.actorId ?? op.unitId)))));
    const conflict = operations.find(op => !overridesFoundation(op)
      && operationTargets(op).some(left => targets.some(right => targetsConflict(left, right))));
    if (conflict) throw new PrivateDraftError('New generated operation overlaps existing draft content; no content was overwritten.',
      { opId: operation.opId, existingOpId: conflict.opId, targets });
    operations.push(operation);
  }
  const postconditions = [...(existing.postconditions ?? [])];
  for (const condition of addition.postconditions ?? []) {
    const old = postconditions.find(p => p.postId === condition.postId);
    if (!old) postconditions.push(condition);
    else if (Object.entries(condition).some(([field, value]) => stable(old[field]) !== stable(value))) {
      throw new PrivateDraftError('Existing clone contract differs; update the plan explicitly.', { postId: condition.postId });
    }
  }
  return { ...existing, operations, postconditions,
    dependsOn: [...new Set([...(existing.dependsOn ?? []), ...(addition.dependsOn ?? [])])].sort() };
}

export function buildPrivateUnitDraft(request, { baseline, query }) {
  const { id, title, summary, commanderId, sourceUnit, sourceActor, redirects = [], changes = [] } = request;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? '') || id.length > 80) throw new PrivateDraftError('Use a valid PatchPlan id.');
  for (const [name, value] of Object.entries({ title, summary, commanderId, sourceUnit, sourceActor })) {
    if (typeof value !== 'string' || !value.trim()) throw new PrivateDraftError(`${name} is required.`);
  }
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 32 || !Array.isArray(changes) || changes.length > 32) {
    throw new PrivateDraftError('Select 1-32 Catalog creation redirects and at most 32 exact field changes.');
  }
  const scope = { kind: 'commander', commanderId };
  const owner = { catalog: 'Unit', objectId: sourceUnit };
  const cache = new Map();
  const ask = input => {
    const encoded = JSON.stringify(input);
    if (!cache.has(encoded)) cache.set(encoded, query(input));
    return cache.get(encoded);
  };
  const get = (catalog, objectId, path) => ask({ operation: 'entity.get', commanderId, catalog, objectId,
    ...(path ? { path } : { include: [] }) });
  const impact = (catalog, objectId) => ask({ operation: 'impact.analyze', catalog, objectId, scope, owner,
    changeType: 'structural', includeIsolationPlan: true, maxDepth: 4, limit: 100 });
  const unit = get('Unit', sourceUnit);
  if (unit.entity.class !== 'CUnit') throw new PrivateDraftError('The source must be an actual CUnit.');
  if (get('Actor', sourceActor).entity.class !== 'CActorUnit') throw new PrivateDraftError('sourceActor must identify a real CActorUnit, not a same-name assumption.');
  const rootImpact = impact('Unit', sourceUnit);
  if (rootImpact.isolation?.requestedScope?.commanderId !== commanderId) throw new PrivateDraftError(
    'Use the resolved canonical commanderId.', { commanderId: rootImpact.isolation?.requestedScope?.commanderId });
  if (rootImpact.isolation?.recommendedStrategy !== 'private-clone') {
    throw new PrivateDraftError('This source needs inspection/reuse, not another automatic clone.', { isolation: rootImpact.isolation?.recommendedStrategy });
  }

  const dependencies = new Set();
  const mapping = new Map();
  const unresolved = [];
  const generated = new Map();
  const add = operation => {
    const target = operation.kind === 'catalog.set' ? pathKey(operation) : key(operation.catalog, operation.object);
    const previous = generated.get(target);
    if (previous && JSON.stringify(previous) !== JSON.stringify(operation)) throw new PrivateDraftError('Conflicting changes inside the draft request.', { target });
    generated.set(target, operation);
  };
  const requireAbsent = (catalog, objectId) => {
    try { get(catalog, objectId); }
    catch (error) { if (/^Unknown Catalog object: /.test(error.message)) return; throw error; }
    throw new PrivateDraftError('Generated ID already exists; inspect its ownership and edit the existing variant.', { catalog, objectId });
  };
  const privateId = (catalog, objectId) => `GameA${objectId.replace(/[^A-Za-z0-9_]/g, '').slice(0, 65)}${digest([id, commanderId, catalog, objectId])}`;
  const mapObject = (catalog, source, explicitId = null) => {
    const sourceKey = key(catalog, source);
    if (mapping.has(sourceKey)) return mapping.get(sourceKey).object;
    const target = explicitId ?? privateId(catalog, source);
    if (target === source || !/^[A-Za-z_][A-Za-z0-9_]{0,119}$/.test(target)) throw new PrivateDraftError('Private IDs must be distinct Catalog identifiers.');
    requireAbsent(catalog, target);
    mapping.set(sourceKey, { catalog, source, object: target });
    const history = ask({ operation: 'patches.for_target', catalog, objectId: source });
    for (const planId of history.requiredDependsOn ?? []) dependencies.add(planId);
    return target;
  };
  const unitId = mapObject('Unit', sourceUnit, request.unitId);
  const actorId = mapObject('Actor', sourceActor, request.actorId);
  const descriptor = (catalog, objectId, path) => {
    const result = get(catalog, objectId, path);
    const edit = result.editState?.catalogEdit;
    if (!edit?.available || !Object.hasOwn(edit, 'expect') || edit.operation.path.includes('[#')) {
      throw new PrivateDraftError('No executable Catalog precondition for this field.', { catalog, objectId, path,
        reason: edit?.reason ?? 'missing-edit-descriptor' });
    }
    for (const planId of edit.requiredDependsOn ?? []) dependencies.add(planId);
    return edit;
  };
  const creation = rootImpact.isolation.ownerEntrypoints?.creationRewires ?? [];
  const selected = new Map();
  for (const entry of redirects) {
    const edit = descriptor(entry.catalog, entry.objectId, entry.path);
    const candidate = creation.find(c => pathKey(c) === pathKey({ ...entry, path: edit.operation.path })
      && c.mechanism === 'commander.unit.clone.redirects' && !c.reviewRequired);
    if (!candidate || edit.expect !== sourceUnit) throw new PrivateDraftError('Selected redirect is not a proven creation reference to this Unit.', { entry });
    selected.set(pathKey(edit.operation), { catalog: entry.catalog, object: entry.objectId, path: edit.operation.path, expect: edit.expect });
  }
  const rootOp = { opId: 'private-unit', kind: 'commander.unit.clone', commanderId, sourceUnit, unitId,
    sourceActor, actorId, redirects: sorted(selected.values()) };
  const analyses = [rootImpact];
  const handledPaths = new Set(rootOp.redirects.map(pathKey));
  for (const change of sorted(changes)) {
    const mappingBefore = new Map(mapping);
    const dependenciesBefore = new Set(dependencies);
    const generatedBefore = new Map(generated);
    const handledBefore = new Set(handledPaths);
    let edit, analysis, route;
    try {
      edit = descriptor(change.catalog, change.objectId, change.path);
      analysis = change.catalog === 'Unit' && change.objectId === sourceUnit ? rootImpact : impact(change.catalog, change.objectId);
      analyses.push(analysis);
      const paths = analysis.isolation?.ownerPaths ?? [];
      if (change.catalog === 'Unit' && change.objectId === sourceUnit) route = [];
      else {
        const matches = change.ownerPath ? paths.filter(p => p.steps.length === change.ownerPath.length && p.steps.every((s, i) =>
          pathKey({ ...s.source, path: s.fieldPath }) === pathKey(change.ownerPath[i]))) : paths;
        if (matches.length !== 1 || !matches[0].steps.length) throw new PrivateDraftError('Select one proven ownerPath; the helper will not choose between ambiguous paths.', {
          candidates: paths.map(p => p.steps.map(s => ({ ...s.source, path: s.fieldPath }))) });
        route = matches[0].steps;
      }
      if (route.length > 8) throw new PrivateDraftError('Owner path exceeds the bounded helper; use explicit PatchPlan operations.');
      for (const node of route.flatMap(step => [step.source, step.target])) {
        if (node.catalog === 'Unit' && node.objectId !== sourceUnit) throw new PrivateDraftError(
          'This path creates another Unit identity with its own Actor/lifecycle. Use an explicit companion-unit plan.', { node });
        if (node.catalog === 'Actor' && node.objectId !== sourceActor && get(node.catalog, node.objectId).entity.class === 'CActorUnit') {
          throw new PrivateDraftError('An additional CActorUnit needs an explicit binding design.', { node });
        }
      }
      // Resolve every path first. An unresolved change must not leave a partial
      // dependency chain or a fabricated reference in the saved draft.
      const links = route.map(step => {
        const link = descriptor(step.source.catalog, step.source.objectId, step.fieldPath);
        if (link.expect !== step.target.objectId) throw new PrivateDraftError('Owner path no longer points to the selected dependency.', { step });
        return { step, link };
      });
      for (const { step } of links) {
        mapObject(step.source.catalog, step.source.objectId);
        mapObject(step.target.catalog, step.target.objectId);
      }
      for (const { step, link } of links) {
        const target = mapping.get(key(step.source.catalog, step.source.objectId)).object;
        const value = mapping.get(key(step.target.catalog, step.target.objectId)).object;
        add({ opId: `rewire-${digest([step.source, link.operation.path])}`, ...link.operation, object: target, expect: link.expect, value });
        handledPaths.add(pathKey(link.operation));
      }
    } catch (error) {
      if (!(error instanceof PrivateDraftError)) throw error;
      mapping.clear(); for (const [k, v] of mappingBefore) mapping.set(k, v);
      dependencies.clear(); for (const value of dependenciesBefore) dependencies.add(value);
      generated.clear(); for (const [k, v] of generatedBefore) generated.set(k, v);
      handledPaths.clear(); for (const value of handledBefore) handledPaths.add(value);
      unresolved.push({ kind: 'change', change, message: error.message, ...error.details });
      continue;
    }
    const target = mapping.get(key(change.catalog, change.objectId))?.object;
    if (!target) throw new PrivateDraftError('The selected change is not connected to the private Unit.');
    add({ opId: `edit-${digest([change.catalog, change.objectId, edit.operation.path])}`,
      ...edit.operation, object: target, expect: edit.expect, value: change.value });
  }
  const clones = sorted([...mapping.values()].filter(m => m.catalog !== 'Unit' || m.source !== sourceUnit)
    .filter(m => m.catalog !== 'Actor' || m.source !== sourceActor));
  const operations = [rootOp, ...clones.map(m => ({ opId: `clone-${digest([m.catalog, m.source])}`, kind: 'catalog.clone',
    catalog: m.catalog, source: m.source, object: m.object })), ...sorted(generated.values())];
  // Checks are induced by changed identities, not a request to audit every
  // property of the source Unit. Never call bounded static coverage complete.
  const affected = new Set(mapping.keys());
  const obligations = new Map();
  const consumerScopes = new Map();
  for (const group of Object.values(rootImpact.isolation.ownerEntrypoints ?? {}).flatMap(value => Array.isArray(value) ? value : [])) {
    if (group.source && group.scopeStatus) consumerScopes.set(key(group.source.catalog, group.source.objectId), group.scopeStatus);
  }
  for (const analysis of analyses) for (const edge of analysis.edges ?? []) {
    if (!affected.has(key(edge.target.catalog, edge.target.objectId))) continue;
    if (handledPaths.has(pathKey({ ...edge.source, path: edge.fieldPath }))) continue;
    if (edge.source.catalog === 'Actor' && edge.source.objectId === sourceActor && edge.target.catalog === 'Unit'
      && edge.target.objectId === sourceUnit && /^@?unitname$/i.test(edge.fieldPath)) continue;
    const kind = edge.source.catalog === 'Upgrade' ? 'upgrade-reference'
      : ['Requirement', 'RequirementNode', 'Validator'].includes(edge.source.catalog) ? 'condition-reference'
      : ['Actor', 'Model'].includes(edge.source.catalog) ? 'presentation-reference' : 'consumer-reference';
    const groupKey = `${kind}/${key(edge.source.catalog, edge.source.objectId)}/${key(edge.target.catalog, edge.target.objectId)}`;
    let item = obligations.get(groupKey);
    if (!item) {
      item = { kind, source: edge.source, changed: edge.target, paths: [],
        scopeStatus: consumerScopes.get(key(edge.source.catalog, edge.source.objectId)) ?? 'unresolved',
        ...(mapping.has(key(edge.source.catalog, edge.source.objectId)) ? { privateConsumer: mapping.get(key(edge.source.catalog, edge.source.objectId)).object } : {}) };
      obligations.set(groupKey, item);
    }
    if (!item.paths.includes(edge.fieldPath)) item.paths.push(edge.fieldPath);
  }
  const scopeRank = value => ['requested-commander', 'shared', 'unresolved', 'outside'].indexOf(value);
  const observed = sorted(obligations.values()).sort((a, b) => scopeRank(a.scopeStatus) - scopeRank(b.scopeStatus)).map(item => ({ ...item,
    pathCount: item.paths.length, paths: item.paths.sort((a, b) => Number(a.includes('[#')) - Number(b.includes('[#')) || a.localeCompare(b, 'en')).slice(0, 4),
    pathsTruncated: item.paths.length > 4 }));
  const plan = { formatVersion: 2, id, title, userSummary: { text: summary }, target: 'game-a.core',
    compatibility: { sc2DataBuild: baseline.sc2.dataBuild, runtimeContract: baseline.schemaVersion }, scope,
    isolation: { strategy: 'private-clone', owner: { catalog: 'Unit', object: sourceUnit } },
    dependsOn: [...dependencies].sort(), operations,
    postconditions: [{ postId: 'private-unit-contract', kind: 'unit.clone', commanderId, sourceUnitId: sourceUnit,
      unitId, sourceActorId: sourceActor, actorId,
      entrypoints: rootOp.redirects.map(({ expect, ...entry }) => ({ kind: 'catalog', ...entry })) }] };
  return { plan, mapping: sorted(mapping.values()), unresolved,
    review: { status: 'draft-only', staticContract: 'Unit/Actor binding, model/name, declared creation entries; checked at plan_prepare',
      obligations: observed.slice(0, 32), obligationCount: observed.length, truncated: observed.length > 32,
      coverage: 'bounded Catalog references; Actor event expressions, dynamic Galaxy and gameplay behavior remain unverified',
      specialChecks: [{ kind: 'actor-event-expressions', catalog: 'Actor', objectId: sourceActor,
        reason: 'Changing Unit/dependency identities may affect On/Macro event expressions not represented in the reference graph. Inspect the affected event slice; do not infer absence from an empty graph.' },
        ...[...mapping.values()].filter(m => m.catalog === 'Abil').map(m => ({ kind: 'ability-command-bindings',
          sourceAbility: m.source, privateAbility: m.object, unitId,
          reason: 'AbilCmd compound strings and alternate ability links may not appear in the graph. Reconnect intended command cards to the private attached Ability; the helper has not claimed this complete.' }))],
      next: 'Keep this draft. Resolve only induced compatibility gaps and the requested behavior, then prepare the complete plan. Do not re-prove player-scoped redirects.' },
    queryCount: cache.size };
}
