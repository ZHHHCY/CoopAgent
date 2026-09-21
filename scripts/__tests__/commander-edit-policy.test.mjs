import assert from 'node:assert/strict';
import test from 'node:test';
import { commanderEditRoute, UPGRADE_SHORTCUTS } from '../lib/commander-edit-policy.mjs';

const input = { scope: { kind: 'commander', commanderId: 'TestCommander' },
  catalog: 'Unit', objectId: 'SampleUnit', className: 'CUnit', path: 'LifeMax', value: 100 };

test('Upgrade shortcuts are exact, bounded numeric Set contracts', () => {
  assert.equal(UPGRADE_SHORTCUTS.length, 1);
  for (const path of ['LifeMax', 'LifeStart']) {
    const result = commanderEditRoute({ ...input, path });
    assert.equal(result.strategy, 'player-upgrade');
    assert.equal(result.whitelistId, 'unit-life-set-v1');
  }
  for (const override of [{ path: 'Speed' }, { path: 'lifemax' }, { className: 'CFutureUnit' },
    { catalog: 'Behavior' }, { value: '100' }, { value: true }, { value: NaN }, { value: Infinity },
    { value: -1 }, { changeType: 'structural' }, { changeType: 'reference' }]) {
    assert.equal(commanderEditRoute({ ...input, ...override }).strategy, 'private-clone', JSON.stringify(override));
  }
});

test('numbers, booleans and enums outside whitelist all lead to the same private workflow', () => {
  for (const [path, value] of [['Period', 2], ['Arc', 90], ['Options[OnlyFireWhileInAttackOrder]', 1],
    ['AllowedMovement', 'Slowing']]) {
    const route = commanderEditRoute({ ...input, catalog: 'Weapon', objectId: 'SampleWeapon', className: 'CWeaponLegacy', path, value });
    assert.equal(route.strategy, 'private-clone');
    assert.equal(route.nextQuery.catalog, 'Weapon');
    assert.equal(route.nextQuery.objectId, 'SampleWeapon');
    assert.equal(route.nextQuery.owner, undefined, 'do not guess the actual owner from a dependency');
    assert.equal(route.nextQuery.changeType, 'structural');
  }
  assert.deepEqual(commanderEditRoute({ ...input, path: 'Speed' }).nextQuery.owner,
    { catalog: 'Unit', objectId: 'SampleUnit' });
});

test('old Upgrade editing and explicit scope remain compatible, but are not new whitelist entries', () => {
  const legacy = commanderEditRoute({ ...input, path: 'Speed', existingScopedEdit: true });
  assert.equal(legacy.strategy, 'player-upgrade');
  assert.equal(legacy.reason, 'existing-scoped-edit');
  assert.equal(legacy.whitelistId, undefined);
  assert.equal(commanderEditRoute({ ...input, path: 'Speed', localObject: true }).strategy, 'inspect-existing-private');
  assert.equal(commanderEditRoute({ ...input, scope: { kind: 'global' } }).strategy, 'global');
  assert.equal(commanderEditRoute({ ...input, scope: null }).strategy, 'declare-scope');
});
