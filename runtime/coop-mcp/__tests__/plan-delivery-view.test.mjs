import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPlanResult } from '../lib/plan-delivery-view.mjs';

test('warning feedback preserves diagnostic and status without claiming scope proof', () => {
  const input = {status:'prepared',warnings:[{code:'DIRECT_PRIVATE_NOT_PROVEN',message:'Unproven owner'}]};
  const before = structuredClone(input), result = compactPlanResult(input);
  assert.deepEqual(input,before);
  assert.equal(result.status,'prepared');
  assert.equal(result.warnings[0].message,'Unproven owner');
  assert.equal(result.warnings[0].blocking,false);
  assert.match(result.warnings[0].action,/if unresolved/);
  assert.deepEqual(compactPlanResult({status:'error',diagnostics:[{severity:'error'}]}),
    {status:'error',diagnostics:[{severity:'error'}]});
});

test('compact plan feedback exposes existing omissions without restoring the full ledger or changing success', () => {
  const input = { status: 'prepared', preparationId: 'one', delivery: { openCount: 10,
    items: Array.from({length: 10}, (_, i) => ({ id: String(i), kind: 'retained-change', status: 'open', description: 'x'.repeat(1000), references: ['large'] })) } };
  const before = structuredClone(input), view = compactPlanResult(input);
  assert.deepEqual(input, before);
  assert.equal(view.status, 'prepared');
  assert.equal(view.delivery, undefined);
  assert.equal(view.deliveryReminder.policy, 'advisory');
  assert.equal(view.deliveryReminder.items.length, 8);
  assert.equal(view.deliveryReminder.omittedCount, 2);
  assert.equal(view.deliveryReminder.items[0].description.length, 500);
  assert.equal(view.deliveryReminder.items[0].references, undefined);
  assert.deepEqual(compactPlanResult({ status: 'prepared', delivery: { openCount: 0, items: [] } }), { status: 'prepared' });
});
