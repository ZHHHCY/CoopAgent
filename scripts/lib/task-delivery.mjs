import { createHash } from 'node:crypto';

const stable = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const boundedText = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;
// An authoring ledger, not a second game format or a claim of gameplay proof.
export const operationIdentity = op => hash(Object.fromEntries(Object.entries(op).filter(([key]) =>
  ['kind', 'catalog', 'object', 'path', 'index', 'locale', 'key', 'commanderId', 'unitId', 'actorId', 'upgradeId', 'target', 'moduleId', 'hook'].includes(key))));
const operationHash = op => hash(Object.fromEntries(Object.entries(op).filter(([key]) => key !== 'opId')));
const conditionHash = condition => hash(Object.fromEntries(Object.entries(condition).filter(([key]) => key !== 'postId')));

function candidates(plan, expansion) {
  const result = (plan.operations ?? []).map(op => ({ id: `op-${operationIdentity(op).slice(0, 20)}`,
    kind: 'retained-change', identity: operationIdentity(op),
    description: `${op.kind}: ${op.catalog ?? op.commanderId ?? ''}/${op.object ?? op.unitId ?? op.key ?? ''}${op.path ? '.' + op.path : ''}`,
    originalOpId: op.opId }));
  for (const condition of plan.postconditions ?? []) result.push({ id: `post-${conditionHash(condition).slice(0, 20)}`,
    kind: 'retained-postcondition', identity: conditionHash(condition), description: `Preserve postcondition ${condition.postId}` });
  // The unrestricted full-plan path also changes identities. It cannot skip
  // continuity checks merely by avoiding the convenience draft builder.
  for (const op of plan.operations ?? []) {
    if (!['catalog.clone', 'commander.unit.clone'].includes(op.kind)) continue;
    const source = op.sourceUnit ?? op.source;
    const catalog = op.catalog ?? 'Unit';
    result.push({ id: `clone-${hash([catalog, source, op.object ?? op.unitId]).slice(0, 20)}`,
      kind: 'compatibility', description: `Identity change ${catalog}/${source}: inspect affected incoming consumers, upgrades and expression bindings. Preserve intended behavior; unresolved compatibility remains a follow-up, not a submission blocker.`,
      references: [{ catalog, source, object: op.object ?? op.unitId }] });
  }
  // Group incoming references; do not impose dozens of identical review tasks.
  for (const item of expansion?.review?.obligations ?? []) {
    const identity = hash([item.kind, item.changed]);
    let group = result.find(r => r.id === `compat-${identity.slice(0, 20)}`);
    if (!group) { group = { id: `compat-${identity.slice(0, 20)}`, kind: 'compatibility',
      description: `${item.kind}: ${item.changed.catalog}/${item.changed.objectId}`, references: [] }; result.push(group); }
    group.references.push({ source: item.source, paths: item.paths, scopeStatus: item.scopeStatus });
  }
  for (const item of expansion?.review?.specialChecks ?? []) result.push({ id: `compat-${hash(item).slice(0, 20)}`,
    kind: 'compatibility', description: item.reason, references: [item] });
  for (const item of expansion?.unresolved ?? []) result.push({ id: `gap-${hash(item).slice(0, 20)}`,
    kind: 'unresolved-change', description: item.message ?? 'Unresolved requested change', references: [item.change ?? item] });
  return result;
}

export function updateTaskDelivery(previous, plan, { expansion, resolutions = [], evidence } = {}) {
  const state = structuredClone(previous ?? { version: 1, items: {} });
  for (const item of candidates(plan, expansion)) {
    const old = state.items[item.id];
    state.items[item.id] = { ...old, ...item, resolution: old?.resolution ?? null };
    if (old?.references && item.references) {
      const refs = new Map([...old.references, ...item.references].map(r => [stable(r), r]));
      state.items[item.id].references = [...refs.values()];
      if (stable(old.references) !== stable(state.items[item.id].references)) state.items[item.id].resolution = null;
    }
  }
  if (!Array.isArray(resolutions) || resolutions.length > 100) throw Error('Invalid delivery resolutions');
  for (const resolution of resolutions) {
    const item = state.items[resolution.id];
    if (!item) throw Error(`Unknown delivery item: ${resolution.id}`);
    if (!boundedText(resolution.reason, 800) || !Array.isArray(resolution.opIds) || !resolution.opIds.length
      || resolution.opIds.length > 100 || !Array.isArray(resolution.evidenceKeys) || !resolution.evidenceKeys.length
      || resolution.evidenceKeys.length > 16) throw Error('A delivery resolution needs replacement opIds, saved evidenceKeys and a reason, not a completed flag');
    const operations = resolution.opIds.map(id => {
      const op = plan.operations.find(o => o.opId === id);
      if (!op) throw Error(`Delivery resolution references missing operation: ${id}`);
      return { identity: operationIdentity(op), hash: operationHash(op) };
    });
    for (const key of resolution.evidenceKeys) if (!/^[a-f0-9]{64}$/.test(key) || !evidence?.(key)) throw Error('Unknown delivery evidence key');
    item.resolution = { reason: resolution.reason, operations, evidenceKeys: [...new Set(resolution.evidenceKeys)],
      verification: 'explicit-design-binding-not-gameplay-proof' };
  }
  state.planId = plan.id;
  return state;
}

export function taskDeliveryView(state, plan) {
  const operations = new Map((plan?.operations ?? []).map(op => [operationIdentity(op), operationHash(op)]));
  const conditions = new Set((plan?.postconditions ?? []).map(conditionHash));
  const items = Object.values(state?.items ?? {}).map(item => {
    const retained = item.kind === 'retained-change' ? operations.has(item.identity)
      : item.kind === 'retained-postcondition' && conditions.has(item.identity);
    const bound = item.resolution?.operations?.every(op => operations.get(op.identity) === op.hash);
    return { id: item.id, kind: item.kind, description: item.description,
      status: retained ? 'retained' : bound ? 'addressed-by-design' : 'open',
      ...(item.references ? { references: item.references } : {}),
      ...(bound ? { reason: item.resolution.reason, evidenceKeys: item.resolution.evidenceKeys } : {}) };
  });
  return { version: 1, policy: 'advisory', openCount: items.filter(i => i.status === 'open').length, items,
    verification: 'Authoring history and follow-up reminders, not submission gates or gameplay proof. Open items stay visible after application; report relevant limitations rather than claiming full completion.' };
}

const boundedList = (value, max, label) => {
  if (!Array.isArray(value) || value.length > max || value.some(item => !boundedText(item, 800))) {
    throw Error(`Invalid ${label}`);
  }
  return value.map(item => item.trim());
};

// Model-authored delivery claims are kept separate from backend application
// facts. A claim can guide follow-up work; it cannot manufacture a Receipt.
export function normalizeTurnDelivery(value) {
  if (!value || !['complete', 'partial', 'no_change', 'unresolved'].includes(value.outcome)) {
    throw Error('Turn delivery needs outcome complete, partial, no_change or unresolved');
  }
  const completed = boundedList(value.completed ?? [], 24, 'completed delivery items');
  const omitted = boundedList(value.omitted ?? [], 24, 'omitted delivery items');
  if (value.outcome === 'partial' && omitted.length === 0) throw Error('A partial delivery must name an omission');
  if (value.outcome === 'complete' && omitted.length > 0) throw Error('A complete delivery cannot contain omissions');
  const verification = value.verification ?? {};
  if (!['not_checked', 'static_checked', 'runtime_checked'].includes(verification.level ?? 'not_checked')
    || (verification.notes !== undefined && !boundedText(verification.notes, 1200))) {
    throw Error('Invalid delivery verification');
  }
  return { source: 'model', outcome: value.outcome, completed, omitted,
    verification: { level: verification.level ?? 'not_checked', runtimeVerified: verification.level === 'runtime_checked',
      ...(verification.notes ? { notes: verification.notes.trim() } : {}) } };
}

export function appendRequestItem(previous, { id, turnId, message, createdAt }) {
  if (!boundedText(id, 100) || !boundedText(turnId, 100) || !boundedText(message, 20_000)) throw Error('Invalid request item');
  const items = structuredClone(previous ?? []);
  if (!items.some(item => item.id === id)) items.push({ id, sourceTurnId: turnId,
    sourceMessage: message.trim(), createdAt, deliveryClaims: [] });
  return items;
}

export function attachDeliveryClaim(previous, { requestId, turnId, delivery }) {
  const items = structuredClone(previous ?? []);
  const item = items.find(entry => entry.id === requestId);
  if (!item) throw Error(`Unknown request item: ${requestId}`);
  item.deliveryClaims ??= [];
  item.deliveryClaims.push({ turnId, outcome: delivery.outcome, completed: delivery.completed,
    omitted: delivery.omitted, source: 'model' });
  return items;
}
