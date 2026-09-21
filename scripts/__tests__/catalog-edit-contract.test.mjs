import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { canonicalEditPath } from '../lib/catalog-edit-contract.mjs';
import { inspectCatalogEditValue } from '../lib/patch-plan-executor.mjs';

const document = source => new DOMParser().parseFromString(`<Catalog>${source}</Catalog>`, 'application/xml');
test('Train arrays do not change WarpTrain scalar semantics', () => {
  assert.equal(canonicalEditPath('CAbilTrain', 'InfoArray[Train3].Unit'), 'InfoArray[Train3].Unit[0]');
  assert.equal(canonicalEditPath('CAbilWarpTrain', 'InfoArray[Train3].Unit'), 'InfoArray[Train3].Unit');
  for (const cls of ['CAbilTrain', 'CAbilWarpTrain']) {
    const doc = document(`<${cls} id="Train"><InfoArray index="Train3"><Unit value="Ship"/></InfoArray></${cls}>`);
    const inspect = catalogPath => inspectCatalogEditValue({ baseDocument: doc, baseObject: doc.documentElement.firstChild, catalogPath });
    assert.equal(inspect(canonicalEditPath(cls, 'InfoArray[Train3].Unit')).value, 'Ship');
    if (cls === 'CAbilTrain') assert.throws(() => inspect('InfoArray[Train3].Unit'), /use InfoArray\[Train3\].Unit\[0\]/);
  }
});

test('numeric siblings, XML attributes and explicit overrides resolve without inventing values', () => {
  const doc = document('<CUnit id="Ship"><WeaponArray Link="A"/><WeaponArray Link="B"/><WeaponArray index="1" Link="C"/></CUnit>');
  const inspect = catalogPath => inspectCatalogEditValue({ baseDocument: doc, baseObject: doc.documentElement.firstChild, catalogPath });
  assert.equal(inspect('WeaponArray[0].Link').value, 'A');
  assert.equal(inspect('WeaponArray[1].Link').value, 'C');
  assert.equal(inspect('WeaponArray[2].Link').exists, false);
});

test('derived weapon defaults and engine observations preserve local overrides', () => {
  const base = document('<CWeaponLegacy id="Gun"/><CWeaponLegacy default="1"/><CWeapon default="1"><Range value="5"/></CWeapon>');
  const input = { baseDocument: base, baseObject: base.documentElement.firstChild, catalogPath: 'Range' };
  assert.equal(inspectCatalogEditValue(input).value, '5');
  assert.equal(inspectCatalogEditValue({ ...input, engineField: { value: '7' } }).value, '7');
  const core = document('<CWeaponLegacy id="Gun"><Range value="9"/></CWeaponLegacy>');
  assert.equal(inspectCatalogEditValue({ ...input, coreDocument: core, coreObject: core.documentElement.firstChild, engineField: { value: '7' } }).value, '9');
});

test('ability Cost positional records use an explicit editable slot and inherit untouched members', () => {
  assert.equal(canonicalEditPath('CAbilEffectTarget', 'Cost[#0].Cooldown.@TimeUse'),
    'Cost[0].Cooldown.@TimeUse');
  assert.equal(canonicalEditPath('CAbilEffectTarget', 'Cost.Cooldown.TimeUse'),
    'Cost[0].Cooldown.TimeUse');
  assert.equal(canonicalEditPath('CUnit', 'Cost[#0].Cooldown.@TimeUse'),
    'Cost[#0].Cooldown.@TimeUse', 'the adapter is confined to ability classes');

  const base = document(`<CAbilEffectTarget id="Orb"><Cost><Vital index="Energy" value="50"/>
    <Cooldown TimeUse="2"/></Cost><Cost index="0"><Vital index="Energy" value="100"/></Cost></CAbilEffectTarget>`);
  const object = base.documentElement.firstChild;
  assert.equal(inspectCatalogEditValue({ baseDocument: base, baseObject: object,
    catalogPath: 'Cost[0].Cooldown.@TimeUse' }).value, '2');
  assert.equal(inspectCatalogEditValue({ baseDocument: base, baseObject: object,
    catalogPath: 'Cost[0].Vital[Energy]' }).value, '100');

  const laterLoad = document('<CAbilEffectTarget id="Orb"><Cost index="0"><Vital index="Energy" value="100"/></Cost></CAbilEffectTarget>');
  const laterObject = laterLoad.documentElement.firstChild;
  assert.equal(inspectCatalogEditValue({ baseDocument: laterLoad, baseObject: laterObject,
    catalogPath: 'Cost[0].Cooldown.@TimeUse' }).exists, false);
  const projected = inspectCatalogEditValue({ baseDocument: laterLoad, baseObject: laterObject,
    catalogPath: 'Cost[0].Cooldown.@TimeUse', projectedField: { value: '2' } });
  assert.equal(projected.value, '2');
  assert.equal(projected.source, 'official');
});
