import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fieldAccesses, indexGalaxyCatalogAccesses } from '../../../scripts/lib/field-usage-index.mjs';
import { createFieldUsageReader, fieldUsageIndexStats } from '../lib/field-usage.mjs';

test('Galaxy field usage index handles nesting, strings, comments, dynamic access and function boundaries', () => {
  const source = `
void ReadConfig () {
    fixed value = Wrap(libNtve_gf_CatalogFieldValueGetAsReal(c_gameCatalogEffect, "ConfigDummy", "Amount", Player(One(1))));
    string text = "// CatalogFieldValueSet(c_gameCatalogEffect, \\"StringFake\\", \\"Amount\\", 1, \\"2\\") /* ( */";
    // CatalogFieldValueSet(c_gameCatalogEffect, "Ignored", "Amount", 1, "2");
    /* CatalogFieldValueGet(c_gameCatalogEffect, "BlockIgnored", "Amount", 1); */
    CatalogFieldValueModify(c_gameCatalogBehavior, "RuntimeValue", "Modification.AttackSpeedMultiplier", 1, FixedToString((1 + value), 3), c_upgradeOperationSet);
    CatalogFieldValueGet(c_gameCatalogEffect, objectId, "Amount", 1);
}
void Empty () { int nothing = 0; }
CatalogFieldValueSet(c_gameCatalogEffect, "GlobalRuntime", "Amount", 1, "2");`;
  const indexed = indexGalaxyCatalogAccesses([{ source_file: 'sample.galaxy', sha256: 'abc', contents: source }]);
  assert.deepEqual(fieldAccesses(indexed, 'Effect', 'ConfigDummy', 'Amount').map(item => item.direction), ['read']);
  const modified = fieldAccesses(indexed, 'Behavior', 'RuntimeValue', 'Modification.AttackSpeedMultiplier')[0];
  assert.equal(modified.direction, 'write');
  assert.equal(modified.operation, 'modify');
  assert.equal(indexed.some(item => item.objectId === 'Ignored'), false);
  assert.equal(indexed.some(item => item.objectId === 'BlockIgnored'), false);
  assert.equal(indexed.some(item => item.objectId === 'StringFake'), false);
  assert.equal(indexed.length, 4);
  assert.equal(indexed[0].function, 'ReadConfig');
  assert.equal(indexed.find(item => item.objectId === null).exact, false);
  assert.equal(indexed.find(item => item.objectId === 'GlobalRuntime').function, null);
});

test('shared index exposes reviewed Fenix input and Void Shard runtime-output semantics and invalidates on source version', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES ('sc2Build','B97579');
    CREATE TABLE galaxy_files(source_file TEXT PRIMARY KEY,sha256 TEXT,contents TEXT);`);
  const fenix = `void libCOMI_gf_CM_Fenix_AvengingProtocol (int g) {
    fixed attack = CatalogFieldValueGetAsReal(c_gameCatalogEffect, "AvengingProtocolAttackSpeedDummy", "Amount", 1);
    CatalogFieldValueModify(c_gameCatalogBehavior, behaviorId, "Modification.AttackSpeedMultiplier", 1, FixedToString(1.0 + attack, 3), c_upgradeOperationSet);
  }`;
  const voidShard = `bool libCOMI_gt_VoidACShardModifyHealth_Func (bool run) {
    CatalogFieldValueSet(c_gameCatalogEffect, "VoidShardACDeathGripDamageDummy", "Amount", 1, FixedToString(75.0, 3));
    return true;
  }`;
  db.prepare('INSERT INTO galaxy_files VALUES (?,?,?)').run('official.galaxy', 'v1', `${fenix}\n${voidShard}`);
  const options = { inspect: () => ({ edit: { available: false, reason: 'fixture' } }), dependencies: () => [] };
  const first = createFieldUsageReader(db, options);
  const attack = first.forField('Effect', 'AvengingProtocolAttackSpeedDummy', 'Amount');
  const damage = first.forField('Effect', 'VoidShardACDeathGripDamageDummy', 'Amount');
  const discovery = first.forObject('Behavior', 'FenixChampionSwapBoost');
  assert.deepEqual(attack.uses, ['script-input']);
  assert.equal(attack.mechanism.role, 'avenging-protocol-attack-speed-per-stack-input');
  assert.match(attack.mechanism.formula, /activeStacks \* Amount/);
  assert.deepEqual(damage.uses, ['script-output']);
  assert.match(damage.mechanism.warning, /static Amount edit does not change/);
  assert.deepEqual(discovery.map(item => item.target), [{ catalog: 'Effect', objectId: 'AvengingProtocolAttackSpeedDummy', path: 'Amount' }]);
  assert.equal(fieldUsageIndexStats(db).builds, 1);
  createFieldUsageReader(db, options).forField('Effect', 'AvengingProtocolAttackSpeedDummy', 'Amount');
  assert.equal(fieldUsageIndexStats(db).builds, 1);
  db.prepare('UPDATE galaxy_files SET sha256=?,contents=? WHERE source_file=?').run('v2', `${fenix}\n${voidShard}\nvoid NewRead(){ CatalogFieldValueGet(c_gameCatalogEffect, "NewDummy", "Amount", 1); }`, 'official.galaxy');
  const newField = createFieldUsageReader(db, options).forField('Effect', 'NewDummy', 'Amount');
  assert.deepEqual(newField.uses, ['script-input']);
  assert.equal(fieldUsageIndexStats(db).builds, 2);
  db.close();
});

test('Raynor mastery evidence identifies the display operand and supported gameplay parameter', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO meta VALUES ('sc2Build','B97579');
    CREATE TABLE galaxy_files(source_file TEXT PRIMARY KEY,sha256 TEXT,contents TEXT);
  `);
  db.prepare('INSERT INTO galaxy_files VALUES (?,?,?)').run('starcoop:libcomi.galaxy', 'source-hash', `
void libCOMI_gf_CM_RaynorUpgradeResearchCost (int lp_player, int lp_level) {
    lv_changedFactor = (1-(IntToFixed(lp_level)*0.02));
    lv_researchCount = CatalogFieldValueCount(c_gameCatalogUpgrade, lv_upgrade, "AffectedUnitArray", lp_player);
    CeilingI((lv_default*lv_changedFactor));
}`);
  const operation = { kind: 'commander.stat.set', commanderId: 'TerranRaynor', catalog: 'Effect',
    object: 'GameARaynorResearchCostPerPoint', path: 'Amount' };
  const reader = createFieldUsageReader(db, { inspect: () => ({ coreCatalog: { value: 0.02 },
    edit: { available: true, expect: 0.02, operation } }), dependencies: () => [] });
  const display = reader.forField('Effect', 'MasteryRaynorResearchCostDisplayDummy', 'Amount', { display: true });
  const mechanism = reader.forMastery('MasteryRaynorResearchCost');
  assert.deepEqual(display.uses, ['display']);
  assert.equal(mechanism.status, 'supported');
  assert.equal(mechanism.official.baselinePerPoint, 0.02);
  assert.equal(mechanism.implementation.currentValue, 0.02);
  assert.deepEqual(mechanism.implementation.edit.operation, operation);
  db.close();
});
