import assert from 'node:assert/strict';
import test from 'node:test';
import {DOMParser} from '@xmldom/xmldom';
import {mergeElement, flattenObject} from '../lib/casc-database-builder.mjs';
const parse = source => new DOMParser().parseFromString(source,'text/xml').documentElement;
const values = (node, key) => [...flattenObject(node).fields.values()].filter(f=>f.path.replaceAll('.@','.')===key).map(f=>f.value);

test('later scalar XML spelling replaces an earlier spelling without losing siblings', () => {
  // Native B97579 observation: SOASuperShield ModifyLimit is 100, not the older
  // campaign child value 200. The source definitions must remain independent.
  const campaign = parse('<CBehaviorBuff id="Shield"><DamageResponse><Chance value="1"/><ModifyLimit value="200"/></DamageResponse><Duration value="20"/></CBehaviorBuff>');
  mergeElement(campaign,parse('<CBehaviorBuff id="Shield"><DamageResponse ModifyLimit="100"/></CBehaviorBuff>'));
  assert.deepEqual(values(campaign,'DamageResponse.ModifyLimit'),['100']);
  assert.deepEqual(values(campaign,'DamageResponse.Chance'),['1']);
  assert.deepEqual(values(campaign,'Duration'),['20']);
  mergeElement(campaign,parse('<CBehaviorBuff id="Shield"><DamageResponse><ModifyLimit value="150"/></DamageResponse></CBehaviorBuff>'));
  assert.deepEqual(values(campaign,'DamageResponse.ModifyLimit'),['150']);
});

test('same-definition ambiguity and indexed/structured members are not silently collapsed', () => {
  const base = parse('<CBehaviorBuff id="Shield"><DamageResponse ModifyLimit="50"/></CBehaviorBuff>');
  mergeElement(base,parse('<CBehaviorBuff id="Shield"><DamageResponse ModifyLimit="100"><ModifyLimit value="200"/></DamageResponse></CBehaviorBuff>'));
  assert.deepEqual(values(base,'DamageResponse.ModifyLimit').sort(),['100','200']);
  const structured = parse('<CUpgrade id="U"><EffectArray index="0" Value="1"/><Thing><Child value="5"/></Thing></CUpgrade>');
  mergeElement(structured,parse('<CUpgrade id="U" EffectArray="unresolved" Thing="unresolved"/>'));
  assert.ok(structured.getElementsByTagName('EffectArray').length);
  assert.deepEqual(values(structured,'Thing.Child'),['5']);
});
