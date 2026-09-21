import assert from 'node:assert/strict';
import test from 'node:test';
import { solveScalar, checkScalarCalculations } from '../lib/scalar-solve.mjs';
import { readScopedBatch } from '../lib/scoped-read-batch.mjs';

const target = { catalog: 'Unit', objectId: 'TestUnit', path: 'CostResource[Vespene]' };
const request = (transform, extra = {}) => ({ commanderId: 'TestCommander', target, transform, ...extra });
function fixture({ base = 50, operand = 40, operation = 'Subtract', scoped, modifierCount = 1 } = {}) {
  const state = { base, operand, operation, scoped, modifierCount };
  const api = {
    withProjectDatabase(_context, fn) { return fn(); },
    execute(q) {
      if (q.fieldPrefix) {
        // Put relevant modifiers beyond page one to catch silent truncation.
        if (!q.offset) return { fields: [], nextOffset: 100, truncated: true };
        return { fields: Array.from({ length: state.modifierCount }, (_, i) => [
          { path: `EffectArray[#${i + 40}]`, value: String(state.operand) },
          { path: `EffectArray[#${i + 40}].@Reference`, value: 'Unit,TestUnit,CostResource[Vespene]' },
          { path: `EffectArray[#${i + 40}].@Operation`, value: state.operation },
        ]).flat(), nextOffset: null, truncated: false };
      }
      const isUpgrade = q.catalog === 'Upgrade';
      const expect = isUpgrade ? state.operand : state.base;
      const op = { kind: isUpgrade ? 'catalog.set' : 'commander.stat.set',
        ...(isUpgrade ? {} : { commanderId: q.commanderId, ...(q.prestigeUpgrade ? { prestigeUpgrade: q.prestigeUpgrade } : {}) }),
        catalog: q.catalog, object: q.objectId, path: q.path };
      const catalogEdit = { available: true, expect, operation: { ...op, kind: 'catalog.set' }, requiredDependsOn: ['prior'] };
      return { editState: { catalogEdit, coreCatalog: { value: state.base },
        commanderPatch: isUpgrade || state.scoped === undefined ? null : { value: state.scoped },
        edit: { available: true, operation: op, expect: state.scoped ?? expect, requiredDependsOn: ['prior'] } } };
    },
  };
  return { api, state };
}

test('selected prestige uses current project base, inverse Subtract and all pages', () => {
  const { api } = fixture();
  const result = solveScalar(api, request({ kind: 'multiply', value: 0.6 }, { prestigeUpgrade: 'P2' }));
  assert.equal(result.catalogValue, 50);
  assert.equal(result.currentValue, 10);
  assert.equal(result.desiredValue, 6);
  assert.deepEqual(result.operation, { kind: 'catalog.set', catalog: 'Upgrade', object: 'P2',
    path: 'EffectArray[40].@Value', opId: 'scalar-change', expect: 40, value: 44 });
  assert.deepEqual(result.requiredDependsOn, ['prior']);
  assert.equal(result.postcondition.value, 6);
  assert.equal(result.postcondition.runtimeVerified, false);
  assert.equal(result.handoff.action, 'reuse-operation-with-evidence-based-scope');
  assert.deepEqual(result.handoff.verificationQuery, { operation:'entity.get', commanderId:'TestCommander', prestigeUpgrade:'P2', ...target });
});

test('inverse operations and explicit catalog basis', () => {
  for (const [operation, base, operand, current, desired, expected] of [
    ['Add', 100, 100, 200, 125, 25], ['Subtract', 200, 40, 160, 96, 104],
    ['Multiply', 100, 2, 200, 125, 1.25], ['Divide', 100, 2, 50, 25, 4], ['Set', 100, 20, 20, 30, 30],
  ]) {
    const { api } = fixture({ operation, base, operand });
    const result = solveScalar(api, request({ kind: 'set', value: desired }, { prestigeUpgrade: 'P2' }));
    assert.equal(result.currentValue, current);
    assert.equal(result.operation.value, expected);
  }
  const { api } = fixture();
  const r = solveScalar(api, request({ kind: 'multiply', value: 0.6 }, { basis: 'catalog', prestigeUpgrade: 'P2' }));
  assert.equal(r.currentValue, 50);
  assert.equal(r.operation.value, 30);
  assert.equal(r.operation.prestigeUpgrade, 'P2');
});

test('decimal transforms, percentages, no-op and explicit rounding', () => {
  for (const [base, kind, value, expected] of [[0.1, 'add', 0.2, 0.3], [26, 'subtract', 2, 24],
    [100, 'decrease-percent', 25, 75], [100, 'increase-percent', 20, 120], [1.5, 'divide', 2, 0.75]]) {
    assert.equal(solveScalar(fixture({ base }).api, request({ kind, value })).operation.value, expected);
  }
  const { api } = fixture({ base: 40 });
  const noop = solveScalar(api, request({ kind: 'set', value: 40 }));
  assert.equal(noop.status, 'already-at-target'); assert.equal(noop.operation, null);
  assert.throws(() => solveScalar(api, request({ kind: 'divide', value: 3 })), /roundingDecimals/);
  assert.equal(solveScalar(api, request({ kind: 'divide', value: 3 }, { roundingDecimals: 2 })).operation.value, 13.33);
  assert.throws(() => solveScalar(api, request({ kind: 'divide', value: 0 })), /zero/);
  assert.throws(() => solveScalar(api, request({ kind: 'set', value: true })), /boolean/);
  assert.throws(() => solveScalar(fixture({ base: true }).api, request({ kind: 'set', value: 1 })), /boolean/);
});

test('damage reduction, bonus and supply meanings preserve field semantics', () => {
  const r = solveScalar(fixture({ base: 0.5 }).api, request({ kind: 'set', value: 40 }, {
    target: { catalog: 'Behavior', objectId: 'TestBuff', path: 'DamageResponse.@ModifyFraction' }, meaning: 'damage-reduction-percent' }));
  assert.equal(r.currentMeaning, 50); assert.equal(r.operation.value, 0.6);
  const bonus = solveScalar(fixture({ base: 0.3, operand: 0.3 }).api, request({ kind: 'set', value: 20 }, {
    target: { catalog: 'Upgrade', objectId: 'Recruit', path: 'EffectArray[0].@Value' }, meaning: 'bonus-percent' }));
  assert.equal(bonus.operation.value, 0.2);
  assert.equal(solveScalar(fixture({ base: -2 }).api, request({ kind: 'set', value: 4 }, {
    target: { ...target, path: 'Food' }, meaning: 'supply-cost' })).operation.value, -4);
  assert.throws(() => solveScalar(fixture().api, request({ kind: 'set', value: 4 }, { meaning: 'supply-cost' })), /Unit.Food/);
});

test('continuous scoped edits use their current Set and refuse ambiguous modifier chains', () => {
  const { api } = fixture({ base: 100, scoped: 80 });
  const r = solveScalar(api, request({ kind: 'subtract', value: 20 }));
  assert.equal(r.currentValue, 80); assert.equal(r.operation.expect, 80); assert.equal(r.operation.value, 60);
  assert.throws(() => solveScalar(api, request({ kind: 'subtract', value: 20 }, { basis: 'catalog' })), /already overrides/);
  assert.throws(() => solveScalar(fixture({ modifierCount: 2 }).api,
    request({ kind: 'multiply', value: 0.6 }, { prestigeUpgrade: 'P2' })), /Multiple prestige/);
  assert.throws(() => solveScalar(fixture({ operation: 'Invented' }).api,
    request({ kind: 'multiply', value: 0.6 }, { prestigeUpgrade: 'P2' })), /Unsupported Upgrade/);
});

test('preparation rejects changed calculations and stale upstream bases', () => {
  const { api, state } = fixture();
  const input = request({ kind: 'multiply', value: 0.6 }, { prestigeUpgrade: 'P2' });
  const result = solveScalar(api, input);
  const plan = { operations: [result.operation] };
  checkScalarCalculations(api, plan, [{ input, result }]);
  assert.throws(() => checkScalarCalculations(api, { operations: [{ ...result.operation, value: 20 }] }, [{ input, result }]), /differs/);
  state.base = 200;
  assert.throws(() => checkScalarCalculations(api, plan, [{ input, result }]), /stale/);
});

test('batching calculations and their preflight checks retains IDs and reads each explicit scope once',()=>{
  const {api,state}=fixture();let active=null,opens=0;
  api.withProjectDatabase=(context,fn)=>{
    if(active){assert.deepEqual(context,active);return fn();}
    opens++;active=context;try{return fn();}finally{active=null;}
  };
  const inputs=[request({kind:'set',value:20}),request({kind:'set',value:20},{prestigeUpgrade:'P2'})];
  const individual=inputs.map(i=>solveScalar(api,i));opens=0;
  const batched=readScopedBatch(api,[inputs[0],inputs[0],inputs[1]],i=>solveScalar(api,i));
  assert.equal(opens,2);assert.equal(batched[0].calculationId,individual[0].calculationId);
  assert.equal(batched[2].calculationId,individual[1].calculationId);
  opens=0;const plan={operations:individual.map(r=>r.operation)};
  checkScalarCalculations(api,plan,inputs.map((input,i)=>({input,result:individual[i]})));
  assert.equal(opens,2);state.base=51;
  assert.throws(()=>checkScalarCalculations(api,plan,inputs.map((input,i)=>({input,result:individual[i]}))),/stale/);
});
