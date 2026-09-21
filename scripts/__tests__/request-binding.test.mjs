import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveRequestBinding, validateRequestBinding } from '../lib/request-binding.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'request-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databaseFile = path.join(root, 'coop.sqlite'), db = new DatabaseSync(databaseFile);
  db.exec(`CREATE TABLE commanders(id TEXT,commander_object_id TEXT,name_zhcn TEXT,name_enus TEXT);
    CREATE TABLE commander_profiles(commander_id TEXT,profile_json TEXT);
    CREATE TABLE catalog_fields(catalog TEXT,object_id TEXT,path TEXT,value TEXT);
    CREATE TABLE object_references(source_catalog TEXT,source_object_id TEXT,field_path TEXT,
      target_catalog TEXT,target_object_id TEXT,confidence REAL,evidence TEXT);`);
  db.prepare('INSERT INTO commanders VALUES (?,?,?,?)').run('TerranNova', 'TerranNova', '诺娃', 'Nova');
  db.prepare('INSERT INTO commanders VALUES (?,?,?,?)').run('TerranRaynor', 'TerranRaynor', '雷诺', 'Raynor');
  db.prepare('INSERT INTO commanders VALUES (?,?,?,?)').run('ProtossKarax', 'ProtossKarax', '凯拉克斯', 'Karax');
  db.prepare('INSERT INTO commander_profiles VALUES (?,?)').run('ProtossKarax', JSON.stringify({
    prestiges: [{ index: 0, id: 'KaraxP1' }],
  }));
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Weapon', 'NovaGroundWeapon', 'TargetFilters', 'Ground;');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Weapon', 'NovaAirWeapon', 'TargetFilters', 'Air;');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Unit', 'NovaLiberatorGround', 'WeaponArray[0].@Link', 'NovaGroundWeapon');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Unit', 'NovaLiberatorAir', 'WeaponArray[0].@Link', 'NovaAirWeapon');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Upgrade', 'KaraxP1', 'EffectArray[3].@Reference', 'Behavior,KaraxUnitSpawnBarrierDisabled,Duration');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Upgrade', 'KaraxP1', 'EffectArray[3].@Operation', 'Subtract');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Upgrade', 'KaraxP1', 'EffectArray[3]', '180');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Upgrade', 'ZeratulMastery', 'EffectArray[0].@Reference', 'Weapon,ZeratulWeaponA,RateMultiplier');
  db.prepare('INSERT INTO catalog_fields VALUES (?,?,?,?)').run('Upgrade', 'ZeratulMastery', 'EffectArray[1].@Reference', 'Weapon,ZeratulWeaponB,RateMultiplier');
  db.prepare('INSERT INTO object_references VALUES (?,?,?,?,?,?,?)').run('Weapon', 'NovaGroundWeapon', 'Effect', 'Effect', 'NovaGroundDamage', 1, 'test');
  db.prepare('INSERT INTO object_references VALUES (?,?,?,?,?,?,?)').run('Weapon', 'NovaAirWeapon', 'Effect', 'Effect', 'NovaAirDamage', 1, 'test');
  db.close();
  return databaseFile;
}

const plan = (object, scope = { kind: 'commander', commanderId: 'TerranNova' }) => ({
  formatVersion: 2, scope, isolation: { strategy: scope.kind === 'global' ? 'global' : 'player-upgrade' },
  operations: [{ opId: 'damage', kind: 'commander.stat.set', commanderId: 'TerranNova',
    catalog: 'Effect', object, path: 'Amount', expect: 10, value: 20 }],
});

test('binding uses database-backed user names and a later explicit correction', t => {
  const databaseFile = fixture(t);
  let binding = deriveRequestBinding({ databaseFile, messages: [{ turnId: 'turn-1', text: '把诺娃的对地伤害改为20' }] });
  assert.deepEqual(binding.scope.commanderIds, ['TerranNova']);
  assert.deepEqual(binding.effectPlanes, ['ground']);
  binding = deriveRequestBinding({ databaseFile, messages: [
    { turnId: 'turn-1', text: '把诺娃的对地伤害改为20' },
    { turnId: 'turn-2', text: '纠正：改成雷诺的对空伤害' },
  ] });
  assert.deepEqual(binding.scope.commanderIds, ['TerranRaynor']);
  assert.deepEqual(binding.effectPlanes, ['air']);
  assert.equal(binding.scope.source.turnId, 'turn-2');
  binding = deriveRequestBinding({ databaseFile, messages: [{ turnId: 'turn-3', text: '把凯拉克的冷却改为60' }] });
  assert.deepEqual(binding.scope.commanderIds, ['ProtossKarax']);
});

test('a named commander cannot be broadened to global or switched to another commander', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ text: '把诺娃的对地伤害改为20' }] });
  assert.throws(() => validateRequestBinding(plan('NovaGroundDamage', { kind: 'global' }), binding, { databaseFile }), /REQUEST_SCOPE_MISMATCH/);
  assert.throws(() => validateRequestBinding({ ...plan('NovaGroundDamage'), scope: { kind: 'object' },
    isolation: { strategy: 'direct-private' } }, binding, { databaseFile }), /REQUEST_SCOPE_MISMATCH/);
  assert.throws(() => validateRequestBinding({ ...plan('NovaGroundDamage'),
    scope: { kind: 'commander', commanderId: 'TerranRaynor' } }, binding, { databaseFile }), /REQUEST_COMMANDER_MISMATCH/);
});

test('ground and air damage targets are checked through weapon/effect evidence', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ text: '把诺娃的对地伤害改为20' }] });
  assert.doesNotThrow(() => validateRequestBinding(plan('NovaGroundDamage'), binding, { databaseFile }));
  assert.throws(() => validateRequestBinding(plan('NovaAirDamage'), binding, { databaseFile }), /REQUEST_EFFECT_MISMATCH.*ground.*air/);
});

test('an unresolved same-name ground/air form cannot silently become a one-plane write', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ text: '把诺娃的掠袭解放者伤害改为20' }] });
  const evidence = [{ input: { operation: 'entity.resolve', catalog: 'Unit', query: '掠袭解放者' }, output: {
    operation: 'entity.resolve', resolved: false, candidates: [
      { catalog: 'Unit', objectId: 'NovaLiberatorGround', nameZhCN: '掠袭解放者' },
      { catalog: 'Unit', objectId: 'NovaLiberatorAir', nameZhCN: '掠袭解放者' },
    ],
  } }];
  assert.throws(() => validateRequestBinding(plan('NovaAirDamage'), binding, { databaseFile, evidence }),
    /REQUEST_EFFECT_FORM_CONFIRMATION_REQUIRED.*ground and air.*only air/);
  const explicit = deriveRequestBinding({ databaseFile, messages: [{ text: '把诺娃的掠袭解放者对空伤害改为20' }] });
  assert.doesNotThrow(() => validateRequestBinding(plan('NovaAirDamage'), explicit, { databaseFile, evidence }));
});

test('an already-at-target solve cannot be replaced by an unrelated scalar submission', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ text: '把诺娃的伤害设置为10' }] });
  const evidence = [{ input: { operation: 'scalar.solve' }, output: { results: [{ status: 'already-at-target',
    target: { catalog: 'Effect', objectId: 'NovaGroundDamage', path: 'Amount' }, operation: null }] } }];
  assert.throws(() => validateRequestBinding(plan('NovaAirDamage'), binding, { databaseFile, evidence }), /REQUEST_ALREADY_SATISFIED/);
});

test('an explicit post-prestige activation condition rejects the earlier generated Upgrade hook', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ turnId: 'turn-1',
    text: '仅在凯拉克 P2 下把护盾改为125。只有能证明修改在原版威望应用后实际激活时才提交，否则不要提交。' }] });
  assert.equal(binding.condition.activationTiming, 'after-official-prestige-application');
  assert.equal(binding.condition.proofRequired, true);
  const prestigePlan = { ...plan('NovaGroundDamage', { kind: 'commander', commanderId: 'ProtossKarax' }),
    operations: [{ opId: 'p2-shields', kind: 'commander.stat.set', commanderId: 'ProtossKarax',
      prestigeUpgrade: 'CommanderPrestigeKaraxArmy', catalog: 'Unit', object: 'ZealotPurifier',
      path: 'ShieldsMax', expect: 50, value: 125 }] };
  assert.throws(() => validateRequestBinding(prestigePlan, binding, { databaseFile, evidence: [] }),
    /REQUEST_CONDITION_TIMING_MISMATCH.*before official commander tech/);
});

test('preserving a prestige-derived ratio requires the scaled companion operand', t => {
  const databaseFile = fixture(t);
  const binding = deriveRequestBinding({ databaseFile, messages: [{ turnId: 'turn-1',
    text: '把凯拉克基础冷却从 240 改为 60；保留 P1 的既有派生关系。' }] });
  assert.equal(binding.preservedPrestigeRelation.displayIndex, 1);
  const base = { formatVersion: 2, scope: { kind: 'commander', commanderId: 'ProtossKarax' },
    isolation: { strategy: 'direct-private' }, operations: [{ opId: 'base', kind: 'commander.stat.set',
      commanderId: 'ProtossKarax', catalog: 'Behavior', object: 'KaraxUnitSpawnBarrierDisabled', path: 'Duration',
      expect: 240, value: 60 }] };
  assert.throws(() => validateRequestBinding(base, binding, { databaseFile }),
    /REQUEST_DERIVED_RELATION_MISMATCH.*180 -> 45/);
  const complete = { ...base, operations: [...base.operations, { opId: 'p1', kind: 'catalog.set',
    catalog: 'Upgrade', object: 'KaraxP1', path: 'EffectArray[3].@Value', expect: 180, value: 45 }] };
  assert.doesNotThrow(() => validateRequestBinding(complete, binding, { databaseFile }));
});

test('confirmation answers bind both preserve-75-percent and do-not-modify branches', t => {
  const databaseFile = fixture(t), original = { turnId: 'turn-1', text: '把凯拉克统和屏障基础冷却改为 60 秒' };
  const preserve = deriveRequestBinding({ databaseFile, messages: [original,
    { turnId: 'turn-2', text: '同步保留 P1 的 75% 减免' }] });
  assert.equal(preserve.preservedPrestigeRelation.displayIndex, 1);
  assert.equal(preserve.scalarTarget.object, 'KaraxUnitSpawnBarrierDisabled');
  const wrongTarget = { formatVersion: 2, scope: { kind: 'commander', commanderId: 'ProtossKarax' },
    isolation: { strategy: 'player-upgrade' }, operations: [{ opId: 'wrong', kind: 'commander.stat.set',
      commanderId: 'ProtossKarax', catalog: 'Behavior', object: 'UnityBarrierCooldown', path: 'Duration',
      expect: 300, value: 60 }] };
  assert.throws(() => validateRequestBinding(wrongTarget, preserve, { databaseFile }), /REQUEST_TARGET_MISMATCH/);
  const unresolved = { ...wrongTarget, operations: [{ ...wrongTarget.operations[0], object: 'KaraxUnitSpawnBarrierDisabled',
    expect: 240 }] };
  const initial = deriveRequestBinding({ databaseFile, messages: [original] });
  assert.throws(() => validateRequestBinding(unresolved, initial, { databaseFile }),
    /REQUEST_DERIVED_RELATION_CONFIRMATION_REQUIRED.*180.*-120.*45.*15/);
  const declined = deriveRequestBinding({ databaseFile, messages: [original,
    { turnId: 'turn-2', text: '暂不修改' }] });
  assert.ok(declined.declinedChange);
  assert.throws(() => validateRequestBinding(plan('NovaGroundDamage'), declined, { databaseFile }),
    /REQUEST_DECLINED_CHANGE/);
});

test('heterogeneous mastery rates require a user choice and enforce both branches', t => {
  const databaseFile = fixture(t), original = { turnId: 'turn-1', text: '把泽拉图的战斗单位攻击速度精通改为每点0.75%' };
  const masteryPlan = values => ({ formatVersion: 2, scope: { kind: 'commander', commanderId: 'TerranNova' },
    isolation: { strategy: 'direct-private', owner: { catalog: 'Upgrade', object: 'ZeratulMastery' } },
    operations: values.map((value, index) => ({ opId: `rate-${index}`, kind: 'catalog.set', catalog: 'Upgrade',
      object: 'ZeratulMastery', path: `EffectArray[${index}].@Value`, expect: index ? 0.01 : 0.005, value })),
  });
  const undecided = deriveRequestBinding({ databaseFile, messages: [original] });
  assert.throws(() => validateRequestBinding(masteryPlan([0.0075, 0.015]), undecided, { databaseFile }),
    /REQUEST_MASTERY_SCALING_CONFIRMATION_REQUIRED/);
  const preserve = deriveRequestBinding({ databaseFile, messages: [original,
    { turnId: 'turn-2', text: '保留原来不同单位之间的增益比例。' }] });
  assert.equal(preserve.masteryScalingChoice, 'preserve-ratio');
  assert.doesNotThrow(() => validateRequestBinding(masteryPlan([0.0075, 0.015]), preserve, { databaseFile }));
  assert.throws(() => validateRequestBinding(masteryPlan([0.0075, 0.0075]), preserve, { databaseFile }),
    /REQUEST_MASTERY_SCALING_MISMATCH/);
  const uniform = deriveRequestBinding({ databaseFile, messages: [original,
    { turnId: 'turn-2', text: '所有受这项精通影响的战斗单位都统一成每点 0.75%。' }] });
  assert.equal(uniform.masteryScalingChoice, 'uniform');
  assert.doesNotThrow(() => validateRequestBinding(masteryPlan([0.0075, 0.0075]), uniform, { databaseFile }));
  assert.throws(() => validateRequestBinding(masteryPlan([0.0075, 0.015]), uniform, { databaseFile }),
    /REQUEST_MASTERY_SCALING_MISMATCH/);
});
