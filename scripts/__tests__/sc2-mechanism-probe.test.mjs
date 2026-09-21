import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateMechanismObserver, evaluateMechanism, validateMechanismConfig } from '../lib/sc2-mechanism-probe.mjs';

const make = (scenario, prestige = 0) => generateMechanismObserver({ scenario, prestige, sourceProject: path.resolve('fixture') }, { runId: 'test', bankName: 'TestBank' });
test('integration observer invokes normal preparation and start, never repairs the patch', () => {
  for (const scenario of ['swann', 'karax', 'raynor']) {
    const { galaxy, queries } = make(scenario, 2);
    assert.match(galaxy, /GameA_PreparationOptionsCommanderChanged/);
    assert.match(galaxy, /GameA_OnStart\(false, true\)/);
    assert.doesNotMatch(galaxy, /TechTreeUpgradeAddLevel\([^\n]*GameACommanderStat|CatalogFieldValueSet|UnitSetProperty/);
    assert.equal(new Set(queries.map((r) => r.id)).size, queries.length);
    assert.ok(queries.some((r) => r.id === 'tech-applied-patch0'));
  }
});
test('prestige controls have independent expected values', () => {
  for (const p of [0, 1, 2, 3]) {
    const { queries } = make('karax', p);
    assert.equal(queries.find((r) => r.id === 'new-max').expected, p === 2 ? 125 : 100);
    assert.equal(queries.find((r) => r.id === 'settled-patch0').expected, p === 2 ? 1 : 0);
    assert.equal(queries.find((r) => r.id === 'control-max').expected, 100);
  }
});
test('science vessel preserves +40 on final continuous edit; shared damage uses real damage effect and control', () => {
  assert.equal(make('swann').queries.find((r) => r.id === 'new-max').expected, 300);
  const { galaxy, queries } = make('raynor');
  assert.match(galaxy, /UnitCreateEffectUnit\(attacker, effect, target\)/);
  assert.match(galaxy, /UnitWeaponGet\(attacker, 1\)/);
  for (const [id, expected] of [['raynor-damage', 8], ['raynor-researched-damage', 9], ['unmodified-player-damage', 6]]) {
    assert.equal(queries.find((r) => r.id === id).expected, expected);
  }
});
test('verdict fails numeric mismatch and rejects missing, blank, NaN, stale/bad transport', () => {
  const row = { id: 'damage', expected: 8, valueType: 'number', status: 'complete', value: '8.0000' };
  assert.equal(evaluateMechanism([row], true).status, 'pass');
  assert.equal(evaluateMechanism([{ ...row, value: '6' }], true).status, 'fail');
  for (const value of ['', 'NaN', 'Infinity', undefined]) assert.equal(evaluateMechanism([{ ...row, value }], true).status, 'inconclusive');
  assert.equal(evaluateMechanism([{ ...row, status: 'missing' }], true).status, 'inconclusive');
  assert.equal(evaluateMechanism([row], false).status, 'inconclusive');
  assert.equal(evaluateMechanism([], true).status, 'inconclusive');
});
test('config refuses arbitrary injection and ambiguous extra options', () => {
  assert.throws(() => validateMechanismConfig({ scenario: 'other', sourceProject: path.resolve('.') }));
  assert.throws(() => validateMechanismConfig({ scenario: 'swann', sourceProject: '..' }));
  assert.throws(() => validateMechanismConfig({ scenario: 'swann', sourceProject: path.resolve('.'), prestige: 4 }));
  assert.throws(() => validateMechanismConfig({ scenario: 'swann', sourceProject: path.resolve('.'), script: 'injected' }));
});

test('controlled experiment explicitly diagnoses order and uses concrete research, not default template', () => {
  for (const scenario of ['swann', 'raynor']) {
    const { galaxy, queries } = generateMechanismObserver({ scenario, mode: 'controlled', sourceProject: path.resolve('fixture') }, { runId: 'test', bankName: 'TestBank' });
    assert.doesNotMatch(galaxy, /GameA_OnStart|libCOOC_|CatalogFieldValueSet|UnitSetProperty/);
    assert.match(galaxy, /TechTreeUpgradeAddLevel/);
    assert.ok(queries.some((r) => r.id.startsWith('grant-')));
    assert.equal(new Set(queries.map((r) => r.id)).size, queries.length);
    if (scenario === 'raynor') {
      assert.match(galaxy, /"TerranInfantryWeaponsLevel1"/);
      assert.doesNotMatch(galaxy, /"TerranInfantryWeapons"|UnitWeaponGet\(attacker, 0\)/);
    }
  }
});
