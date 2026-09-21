import assert from 'node:assert/strict';
import test from 'node:test';
import { createScalarParameters, parameterView } from '../lib/scalar-parameters.mjs';
import { executeScalarSearch } from '../lib/scalar-search-view.mjs';

function fixture() {
  const values = new Map([['Unit/A/LifeMax', 100], ['Unit/A/ShieldsMax', 40], ['Weapon/B/Period', 2], ['Upgrade/P/EffectArray[0].@Value', 10]]);
  const dependencies = new Map(), uses = new Map(), calls = [], saved = new Map();
  const key = q => [q.catalog, q.objectId ?? q.object, q.path].join('/');
  const search = {
    withProjectDatabase(_context, fn) { return fn(); },
    execute(q) {
      const value = values.get(key(q)), operation = { kind: q.catalog === 'Upgrade' ? 'catalog.set' : 'commander.stat.set',
        ...(q.catalog === 'Upgrade' ? {} : { commanderId: q.commanderId }), catalog: q.catalog, object: q.objectId, path: q.path };
      const edit = { available: value !== undefined, expect: value, operation, requiredDependsOn: dependencies.get(key(q)) ?? [] };
      return { operation: 'entity.get', entity: { catalog: q.catalog, objectId: q.objectId }, usageEvidence: { uses: uses.get(key(q)) ?? ['unidentified'] },
        editState: { edit, catalogEdit: { ...edit, operation: { ...operation, kind: 'catalog.set' } }, coreCatalog: { value }, commanderPatch: null } };
    },
  };
  let submitError = false, privateProven = true;
  const core = {
    async preparePlan({ plan }) { calls.push(['prepare', plan]); saved.set(plan.id, { plan, applied: false }); return { preparationId: plan.id }; },
    async submitPlan({ preparationId }) {
      calls.push(['submit', preparationId]); const record = saved.get(preparationId);
      if (!record.applied) {
        for (const op of record.plan.operations) { assert.equal(values.get(key(op)), op.expect); values.set(key(op), op.value); dependencies.set(key(op), [record.plan.id]); }
        record.applied = true;
      }
      if (submitError) { submitError = false; throw Error('lost response'); }
      return { status: 'applied', preparationId };
    },
  };
  const parameters = createScalarParameters({ search, core, namespace: 'test', baseline: async () => ({ schemaVersion: 2, sc2: { dataBuild: 'test-build' } }),
    review: async plan => ({ summary: { errorCount: 0 }, diagnostics: plan.operations.filter(op => op.kind === 'catalog.set').map(op => ({ opId: op.opId,
      code: privateProven ? 'DIRECT_PRIVATE_BOUNDED_EVIDENCE' : 'DIRECT_PRIVATE_NOT_PROVEN' })) }),
  });
  const read = (catalog = 'Unit', objectId = 'A', path = 'LifeMax', commanderId = 'Commander') => {
    const query = { operation: 'entity.get', commanderId, catalog, objectId, path };
    return parameters.expose(query, executeScalarSearch(search, query));
  };
  const change = (parameterId, kind = 'set', value = 150) => ({ parameterId, transform: { kind, value } });
  const apply = changes => parameters.apply({ summary: '修改请求的数值', changes });
  return { parameters, search, values, uses, calls, read, change, apply, loseResponse: () => { submitError = true; }, denyPrivate: () => { privateProven = false; } };
}

test('model supplies handles and transforms; backend owns plan, scope and exact arithmetic', async () => {
  const f = fixture(), first = f.read(), other = f.read('Weapon', 'B', 'Period');
  assert.equal(first.parameter.currentValue, 100);
  const visible = parameterView(first);
  assert.equal(visible.editState, undefined);
  assert.ok(visible.parameter.parameterId);
  const result = await f.apply([f.change(first.parameter.parameterId), f.change(other.parameter.parameterId, 'decrease-percent', 25)]);
  assert.equal(result.status, 'applied');
  assert.equal(f.values.get('Unit/A/LifeMax'), 150);
  assert.equal(f.values.get('Weapon/B/Period'), 1.5);
  assert.equal(f.values.get('Unit/A/ShieldsMax'), 40);
  const plan = f.calls[0][1];
  assert.deepEqual(plan.scope, { kind: 'commander', commanderId: 'Commander' });
  assert.deepEqual(plan.isolation, { strategy: 'player-upgrade' });
  assert.equal(plan.compatibility.sc2DataBuild, 'test-build');
});

test('continuous edit uses current facts/dependencies; replay never compounds a relative edit', async () => {
  const f = fixture();
  const input = { summary: '提高单位的生命上限', changes: [f.change(f.read().parameter.parameterId, 'add', 20)] };
  await Promise.all([f.parameters.apply(input), f.parameters.apply(input)]);
  await f.parameters.apply(input);
  assert.equal(f.values.get('Unit/A/LifeMax'), 120);
  assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 1);
  const firstPlan = f.calls[0][1];
  await f.apply([f.change(f.read().parameter.parameterId, 'add', 30)]);
  assert.equal(f.values.get('Unit/A/LifeMax'), 150);
  const lastPlan = f.calls.filter(c => c[0] === 'prepare').at(-1)[1];
  assert.deepEqual(lastPlan.dependsOn, [firstPlan.id]);
  assert.equal(lastPlan.operations[0].expect, 120);
});

test('a stale member aborts the entire batch; unknown, duplicate and mixed commander handles fail', async () => {
  const f = fixture(), life = f.read().parameter.parameterId, shield = f.read('Unit', 'A', 'ShieldsMax').parameter.parameterId;
  f.values.set('Unit/A/LifeMax', 110);
  await assert.rejects(f.apply([f.change(life), f.change(shield)]), /changed/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.apply([f.change('param-invented')]), /unknown/);
  await assert.rejects(f.apply([f.change(shield), f.change(shield)]), /distinct/);
  await assert.rejects(f.apply([f.change(shield), f.change(f.read('Weapon', 'B', 'Period', 'Other').parameter.parameterId)]), /one commander/);
  assert.equal(f.values.get('Unit/A/ShieldsMax'), 40);
});

test('runtime outputs are unavailable; ordinary unknown usage and reviewed script inputs remain editable', async () => {
  const f = fixture();
  f.uses.set('Unit/A/LifeMax', ['script-output']);
  assert.equal(f.read().parameter.available, false);
  assert.equal(f.read().parameter.parameterId, undefined);
  f.uses.set('Unit/A/LifeMax', ['script-input']);
  await f.apply([f.change(f.read().parameter.parameterId)]);
  assert.equal(f.values.get('Unit/A/LifeMax'), 150);
});

test('direct Catalog writes require existing private-scope evidence, not a warning or commander label', async () => {
  const f = fixture();
  const id = f.read('Upgrade', 'P', 'EffectArray[0].@Value').parameter.parameterId;
  f.denyPrivate();
  await assert.rejects(f.apply([f.change(id, 'set', 15)]), /proven private/);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  await g.apply([g.change(g.read('Upgrade', 'P', 'EffectArray[0].@Value').parameter.parameterId, 'set', 15)]);
  assert.equal(g.values.get('Upgrade/P/EffectArray[0].@Value'), 15);
  assert.equal(g.calls[0][1].isolation.strategy, 'direct-private');
});

test('no change produces no plan; one satisfied field does not suppress another field', async () => {
  const f = fixture(), life = f.read().parameter.parameterId;
  assert.equal((await f.apply([f.change(life, 'set', 100)])).status, 'no_change');
  assert.equal(f.calls.length, 0);
  await f.apply([f.change(life, 'set', 100), f.change(f.read('Unit', 'A', 'ShieldsMax').parameter.parameterId, 'set', 60)]);
  assert.equal(f.calls[0][1].operations.length, 1);
  assert.equal(f.values.get('Unit/A/ShieldsMax'), 60);
});

test('no-change is a current observation, not a reusable receipt after the field changes', async () => {
  for (const [catalog, object, path, initial, next] of [
    ['Unit', 'A', 'LifeMax', 100, 120], ['Weapon', 'B', 'Period', 2, 1.5],
  ]) {
    const f = fixture(), input = { summary: '保持当前目标数值', changes: [f.change(f.read(catalog, object, path).parameter.parameterId, 'set', initial)] };
    assert.equal((await f.parameters.apply(input)).status, 'no_change');
    assert.equal((await f.parameters.apply(input)).status, 'no_change', 'unchanged facts remain a valid no-op');
    f.values.set(`${catalog}/${object}/${path}`, next);
    await assert.rejects(f.parameters.apply(input), /changed/, 'an old handle cannot report current success');
    assert.equal(f.values.get(`${catalog}/${object}/${path}`), next);
    assert.equal(f.calls.length, 0);
    await f.apply([f.change(f.read(catalog, object, path).parameter.parameterId, 'set', initial)]);
    assert.equal(f.values.get(`${catalog}/${object}/${path}`), initial, 'a new read permits the intended edit');
  }
});

test('lost submit response preserves preparation identity; retry does not repeat relative arithmetic', async () => {
  const f = fixture(), input = { summary: '生命上限增加二十', changes: [f.change(f.read().parameter.parameterId, 'add', 20)] };
  f.loseResponse();
  let resume;
  await assert.rejects(f.parameters.apply(input), error => { resume = error.details.recovery.resumeInput; return true; });
  assert.equal(f.values.get('Unit/A/LifeMax'), 120);
  await f.parameters.apply(resume);
  await f.parameters.apply(input);
  assert.equal(f.values.get('Unit/A/LifeMax'), 120);
  assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 1);
});

test('malformed changes cannot call the backend; nonnumeric fields have no handle', async () => {
  const f = fixture(), item = f.change(f.read().parameter.parameterId);
  for (const input of [null, { summary: 'test', changes: [] }, { summary: 'test', changes: [item], scope: {} },
    { summary: 'test', changes: [{ ...item, transform: { kind: 'set', value: true } }] },
    { summary: 'test', changes: [{ ...item, expect: 123 }] }, { preparationId: 'p', changes: [item] }]) {
    await assert.rejects(f.parameters.apply(input));
  }
  f.values.set('Unit/A/LifeMax', true);
  assert.equal(f.read().parameter.available, false);
  assert.equal(f.calls.length, 0);
});

test('an exact read with a custom evidence page size does not become falsely stale', async () => {
  const f = fixture(), execute = f.search.execute;
  f.search.execute = q => ({ ...execute(q), fieldInfluences: { returnedLimit: q.limit ?? 4, entries: [] } });
  const query = { operation: 'entity.get', commanderId: 'Commander', catalog: 'Unit', objectId: 'A', path: 'LifeMax', limit: 1 };
  const { parameter } = f.parameters.expose(query, executeScalarSearch(f.search, query));
  await f.apply([f.change(parameter.parameterId)]);
  assert.equal(f.values.get('Unit/A/LifeMax'), 150);
});
