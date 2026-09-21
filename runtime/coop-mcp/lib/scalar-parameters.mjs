import { createHash, randomUUID } from 'node:crypto';
import { solveScalar, SCALAR_TRANSFORMS, SCALAR_MEANINGS } from './scalar-solve.mjs';
import { executeScalarSearch } from './scalar-search-view.mjs';
import { readScopedBatch } from './scoped-read-batch.mjs';
import { compactPlanResult } from './plan-delivery-view.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
function failure(code, message, details = {}) {
  const error = Error(message);
  error.details = { code, ...details };
  return error;
}
function exactQuery(input) {
  return { operation: 'entity.get', commanderId: input.commanderId,
    ...(input.prestigeUpgrade ? { prestigeUpgrade: input.prestigeUpgrade } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    catalog: input.catalog, objectId: input.objectId, path: input.path };
}
// Bind current field, conditions and usage evidence, not timestamps, page sizes
// or model-visible prose. The submission service additionally fences the whole
// project/database/executor snapshot before committing.
function snapshot(facts) {
  return hash({ state: facts.editState, usage: facts.usageEvidence,
    influences: facts.fieldInfluences, project: facts.currentProject, database: facts.database });
}
function unavailable(query, facts) {
  if (!query.commanderId) return 'Select the commander before requesting an editable parameter.';
  if (query.prestigeUpgrade && query.catalog !== 'Upgrade')
    return 'This experiment exposes exact existing Upgrade operands for prestige changes, not conditional final-value solving.';
  if (facts.usageEvidence?.uses?.includes('script-output'))
    return 'This field is written by a runtime script. This interface cannot change that formula.';
  const state = facts.editState;
  if (!state?.edit?.available || !state?.catalogEdit?.available)
    return state?.edit?.reason ?? state?.catalogEdit?.reason ?? 'No supported current field value.';
  if (!finite(state.edit.expect) || !finite(state.catalogEdit.expect)) return 'This parameter is not a finite numeric field.';
  if (!['commander.stat.set', 'catalog.set'].includes(state.edit.operation?.kind))
    return 'This parameter requires a supporting implementation outside this experiment.';
  return null;
}

// Model views carry facts and a bound parameter, never a second plan-writing
// protocol. Saved evidence still uses the original query result.
export function parameterView(value) {
  if (Array.isArray(value)) return value.map(parameterView);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['editState', 'requiredDependsOn', 'authoringRoute'].includes(key))
    .map(([key, child]) => [key, parameterView(child)]));
}

export function validateParameterChanges(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid-input', 'Provide a change object.');
  if ('preparationId' in input) {
    if (Object.keys(input).length !== 1 || typeof input.preparationId !== 'string' || !input.preparationId)
      throw failure('invalid-input', 'Resume with preparationId alone.');
    return;
  }
  if (Object.keys(input).some(key => !['summary', 'changes'].includes(key)) || typeof input.summary !== 'string'
    || input.summary.trim().length < 4 || input.summary.length > 120 || /[\r\n]/.test(input.summary)
    || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 32)
    throw failure('invalid-input', 'Provide a one-line summary (4–120 characters) and 1–32 changes.');
  const ids = new Set();
  for (const item of input.changes) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['parameterId', 'transform', 'meaning', 'roundingDecimals'].includes(key))
      || typeof item.parameterId !== 'string' || !item.parameterId || ids.has(item.parameterId)
      || !item.transform || Object.keys(item.transform).some(key => !['kind', 'value'].includes(key))
      || !SCALAR_TRANSFORMS.includes(item.transform.kind) || !finite(item.transform.value)
      || item.meaning !== undefined && !SCALAR_MEANINGS.includes(item.meaning)
      || item.roundingDecimals !== undefined && (!Number.isInteger(item.roundingDecimals) || item.roundingDecimals < 0 || item.roundingDecimals > 8))
      throw failure('invalid-input', 'Use distinct parameter IDs, supported numeric transforms and explicit valid rounding/meaning.');
    ids.add(item.parameterId);
  }
}

export function createScalarParameters({ search, core, baseline, review, observe = () => {}, namespace = randomUUID() }) {
  const parameters = new Map(), attempts = new Map();
  function expose(input, facts) {
    if (input.operation !== 'entity.get' || !input.path || !input.catalog || !input.objectId || input.topic === 'influences') return facts;
    const query = exactQuery(input), reason = unavailable(query, facts);
    if (reason) return { ...facts, parameter: { available: false, reason } };
    const revision = snapshot(facts), parameterId = `param-${hash([namespace, query, revision]).slice(0, 32)}`;
    parameters.set(parameterId, { query, revision });
    return { ...facts, parameter: { available: true, parameterId, target: { catalog: query.catalog, objectId: query.objectId, path: query.path },
      commanderId: query.commanderId, prestigeUpgrade: query.prestigeUpgrade ?? null,
      currentValue: facts.editState.edit.expect,
      valueContext: 'Current editable field value, not a simulated gameplay total. Transform applies to this field; use an exact Upgrade operand for upgrade bonuses.',
      application: 'Scope is verified by the backend at application. Unsupported isolation is reported without a write.',
      runtimeVerified: false } };
  }
  async function resume(preparationId) {
    try { return compactPlanResult(await core.submitPlan({ preparationId })); }
    catch (error) {
      error.details = { ...(error.details ?? error.submissionDetails ?? {}),
        recovery: { preparationId, resumeInput: { preparationId },
          message: 'Inspect project status before retrying. A lost response does not mean no change was applied.' } };
      throw error;
    }
  }
  async function apply(input) {
    validateParameterChanges(input);
    if (input.preparationId) return resume(input.preparationId);
    const signature = hash(input);
    // Concurrent duplicate calls share the same promise; lost submit responses
    // retain the exact preparation rather than recomputing a relative change.
    const prior = attempts.get(signature);
    if (prior) return prior.pending ?? resume(prior.preparationId);
    const attempt = {};
    attempts.set(signature, attempt);
    attempt.pending = (async () => {
      const selected = input.changes.map(item => {
        const record = parameters.get(item.parameterId);
        if (!record) throw failure('unknown-parameter', 'Read the exact field again in this session; the parameter is unknown or expired.');
        return { item, ...record, commanderId: record.query.commanderId, prestigeUpgrade: record.query.prestigeUpgrade };
      });
      const commanderId = selected[0].query.commanderId;
      if (selected.some(({ query }) => query.commanderId !== commanderId))
        throw failure('mixed-commanders', 'This experiment applies one commander per atomic change. No fields were submitted.');
      const solved = readScopedBatch(search, selected, entry => {
        const { item, query, revision } = entry;
        const fresh = executeScalarSearch(search, query);
        if (snapshot(fresh) !== revision) throw failure('stale-parameter', 'The field or its context changed; read it again before modifying it.', { nextQuery: query });
        const reason = unavailable(query, fresh);
        if (reason) throw failure('unsupported-parameter', reason);
        const calculationInput = { commanderId, ...(query.prestigeUpgrade ? { prestigeUpgrade: query.prestigeUpgrade } : {}),
          target: { catalog: query.catalog, objectId: query.objectId, path: query.path },
          // The handle names the editable field, never an inferred final total.
          basis: 'current', meaning: item.meaning ?? 'number', transform: item.transform,
          ...(item.roundingDecimals !== undefined ? { roundingDecimals: item.roundingDecimals } : {}) };
        const result = solveScalar(search, calculationInput);
        observe(calculationInput, result);
        return result;
      });
      const failures = solved.filter(result => result.status === 'unsupported');
      if (failures.length) throw failure('parameter-check-failed', 'No change was submitted: ' + failures.map(result => result.error).join('; '));
      const operations = solved.filter(result => result.operation).map((result, index) => ({ ...result.operation, opId: `field-${index + 1}` }));
      const changes = solved.map(result => ({ target: result.target, before: result.currentMeaning, after: result.desiredMeaning,
        meaning: result.meaning, status: result.status, runtimeVerified: false }));
      if (!operations.length) return { status: 'no_change', changes, runtimeVerified: false };
      const operationKeys = operations.map(op => [op.catalog, op.object, op.path.replaceAll('.@', '.').toLowerCase()].join('/'));
      if (new Set(operationKeys).size !== operationKeys.length) throw failure('duplicate-target', 'Different parameters resolve to the same field; submit one intended change for it.');
      const direct = operations.filter(op => op.kind === 'catalog.set');
      if (operations.some(op => !['commander.stat.set', 'catalog.set'].includes(op.kind)))
        throw failure('unsupported-operation', 'This field needs a supporting implementation outside this experiment.');
      const version = await baseline();
      const plan = { formatVersion: 2, id: `scalar-${randomUUID()}`, title: input.summary, target: 'game-a.core',
        compatibility: { sc2DataBuild: version.sc2.dataBuild, runtimeContract: version.schemaVersion }, userSummary: { text: input.summary },
        scope: { kind: 'commander', commanderId },
        isolation: direct.length ? { strategy: 'direct-private', owner: { catalog: direct[0].catalog, object: direct[0].object } } : { strategy: 'player-upgrade' },
        operations, dependsOn: [...new Set(solved.flatMap(result => result.requiredDependsOn))], conflictsWith: [] };
      if (direct.length) {
        // Reuse the existing scope evidence; do not infer ownership from names
        // or commanderId. A warning that ownership is unknown is not permission.
        const reviewed = await review(plan);
        const proven = reviewed.diagnostics.filter(d => d.code === 'DIRECT_PRIVATE_BOUNDED_EVIDENCE').map(d => d.opId);
        if (reviewed.summary.errorCount || direct.some(op => !proven.includes(op.opId)))
          throw failure('unsupported-isolation', 'No proven private write route for these parameters. No change was submitted.', { diagnostics: reviewed.diagnostics });
      }
      // Recheck after asynchronous baseline/scope reads. The executor still
      // owns current-value preconditions and immutable transaction snapshots.
      const rechecked = readScopedBatch(search, selected, ({ query, revision }) => {
        if (snapshot(executeScalarSearch(search, query)) !== revision) throw failure('stale-parameter', 'The parameter changed before preparation.', { nextQuery: query });
        return { status: 'current' };
      });
      if (rechecked.some(result => result.status !== 'current')) throw failure('stale-parameter', 'A parameter changed before preparation. Read the selected fields again.');
      const prepared = await core.preparePlan({ plan });
      if (!prepared.preparationId) throw failure('prepare-failed', 'Backend did not return a preparation; nothing was submitted.');
      attempt.preparationId = prepared.preparationId;
      return { ...await resume(prepared.preparationId), changes };
    })();
    try { return await attempt.pending; }
    finally {
      delete attempt.pending;
      // Only a preparation has durable transaction identity. A no-op is a
      // read observation and must be revalidated on the next call.
      if (!attempt.preparationId) attempts.delete(signature);
    }
  }
  return { expose, apply };
}
