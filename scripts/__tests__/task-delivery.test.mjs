import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRequestItem, attachDeliveryClaim, normalizeTurnDelivery,
  updateTaskDelivery, taskDeliveryView } from '../lib/task-delivery.mjs';

const op = (n) => ({ opId: `op-${n}`, kind: 'catalog.set', catalog: 'Unit', object: 'PrivateUnit', path: `Field${n}`, value: n });
const plan = n => ({ id: 'draft', operations: Array.from({ length: n }, (_, i) => op(i)) });
const key = 'a'.repeat(64);
test('18 -> 7 revision preserves eleven reminders without a submission gate', () => {
  const state = updateTaskDelivery(null, plan(18));
  const smaller = { ...plan(7), id: 'different', operations: plan(7).operations.map(o => ({ ...o, opId: `renamed-${o.opId}` })) };
  const revised = updateTaskDelivery(state, smaller);
  assert.equal(taskDeliveryView(revised, smaller).openCount, 11);
  assert.equal(taskDeliveryView(revised, smaller).policy, 'advisory');
  assert.equal(taskDeliveryView(revised, plan(18)).openCount, 0);
});
test('replacement must bind real operations and evidence; later mutation reopens the gap', () => {
  let state = updateTaskDelivery(null, plan(2));
  const smaller = plan(1);
  const id = taskDeliveryView(state, smaller).items.find(i => i.status === 'open').id;
  const resolution = { id, opIds: ['op-0'], evidenceKeys: [key], reason: 'This operation implements the equivalent scoped result shown by the evidence.' };
  assert.throws(() => updateTaskDelivery(state, smaller, { resolutions: [{ id, completed: true }] }), /needs/);
  assert.throws(() => updateTaskDelivery(state, smaller, { resolutions: [resolution] }), /Unknown delivery evidence/);
  assert.throws(() => updateTaskDelivery(state, smaller, { resolutions: [{ ...resolution, opIds: ['missing'] }] }), /missing operation/);
  state = updateTaskDelivery(state, smaller, { resolutions: [resolution], evidence: () => true });
  assert.equal(taskDeliveryView(state, smaller).openCount, 0);
  const renamed = structuredClone(smaller); renamed.operations[0].opId = 'new-name';
  assert.equal(taskDeliveryView(state, renamed).openCount, 0);
  const changed = structuredClone(smaller); changed.operations[0].value = 42;
  assert.equal(taskDeliveryView(state, changed).openCount, 1);
});
test('helper obligations persist through full-plan revisions and new evidence reopens them', () => {
  const p = plan(1);
  const expansion = { review: { obligations: [{ kind: 'upgrade-reference', changed: { catalog: 'Weapon', objectId: 'Weapon' }, source: { catalog: 'Upgrade', objectId: 'A' }, paths: ['EffectArray[0]'] }] } };
  let state = updateTaskDelivery(null, p, { expansion });
  const id = taskDeliveryView(state, p).items.find(i => i.status === 'open').id;
  state = updateTaskDelivery(state, p, { resolutions: [{ id, opIds: ['op-0'], evidenceKeys: [key], reason: 'Explicit replacement' }], evidence: () => true });
  assert.equal(taskDeliveryView(updateTaskDelivery(state, p), p).openCount, 0);
  expansion.review.obligations[0].paths.push('EffectArray[1]');
  assert.equal(taskDeliveryView(updateTaskDelivery(state, p, { expansion }), p).openCount, 1);
});
test('raw clone compatibility and dropped postconditions remain visible as advisory items', () => {
  const p = { ...plan(1), operations: [{ opId: 'clone', kind: 'catalog.clone', catalog: 'Weapon', source: 'Old', object: 'New' }],
    postconditions: [{ postId: 'check', kind: 'unit.ability', unitId: 'New', abilityId: 'Abil' }] };
  const state = updateTaskDelivery(null, p);
  assert.equal(taskDeliveryView(state, p).openCount, 1);
  const revised = { ...p, postconditions: [{ ...p.postconditions[0], postId: 'renamed' }] };
  assert.equal(taskDeliveryView(state, revised).openCount, 1);
  assert.equal(taskDeliveryView(state, { ...p, postconditions: [] }).openCount, 2);
});
test('turn delivery keeps model claims separate and never drops the source request', () => {
  const delivery = normalizeTurnDelivery({ outcome: 'partial', completed: ['玩法数值已改'],
    omitted: ['面板仍是旧值'], verification: { level: 'static_checked', notes: '未启动游戏' } });
  let requests = appendRequestItem([], { id: 'request-1', turnId: 'turn-1', message: '玩法和面板都改为 0.7', createdAt: 1 });
  requests = attachDeliveryClaim(requests, { requestId: 'request-1', turnId: 'turn-1', delivery });
  assert.equal(requests[0].sourceMessage, '玩法和面板都改为 0.7');
  assert.equal(requests[0].deliveryClaims[0].source, 'model');
  assert.throws(() => normalizeTurnDelivery({ outcome: 'partial', completed: [], omitted: [] }), /must name/);
  assert.throws(() => normalizeTurnDelivery({ outcome: 'complete', omitted: ['still open'] }), /cannot/);
});
