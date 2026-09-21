import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('selected difficulty reaches commander and carrier players before official initialization and is restored before host setup', async () => {
  const coreRoot = path.join(root, 'game-a/core/GameA.SC2Mod');
  const [source, core, manifestText, adapter] = await Promise.all([
    readFile(path.join(coreRoot, 'Base.SC2Data/Generated/PreparationOptions.galaxy'), 'utf8'),
    readFile(path.join(coreRoot, 'Base.SC2Data/GameACore.galaxy'), 'utf8'),
    readFile(path.join(coreRoot, 'GameA.Core.json'), 'utf8'),
    readFile(path.join(root, 'game-a/projects/GameA-OblivionExpress.SC2Map/scripts/GameAOblivionExpressAdapter.galaxy'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const module = manifest.galaxy.modules.find(candidate => candidate.path.endsWith('/PreparationOptions.galaxy'));
  assert.equal(module?.beforeMissionStart, 'GameA_PreparationOptionsApplyAfterMissionInit');

  const applyDifficulty = source.split('void GameA_PreparationOptionsApplyDifficulty () {')[1]?.split('\n}')[0] ?? '';
  for (const player of [1, 2, 3, 4]) {
    assert.match(applyDifficulty, new RegExp(`PlayerSetDifficulty\\(${player}, gameA_selectedDifficulty\\)`));
  }
  const apply = source.split('void GameA_PreparationOptionsApply () {')[1]?.split('\n}')[0] ?? '';
  assert.match(apply, /GameA_PreparationOptionsApplyDifficulty\(\)/);
  assert.ok(core.indexOf('GameA_PreparationOptionsApply()') < core.indexOf('GameA_GeneratedConfigureCommander()'));
  assert.ok(adapter.indexOf('GameA_ConfigureCommander()') < adapter.indexOf('GameAI_LoadCoopMission('));

  const restore = source.split('void GameA_PreparationOptionsApplyAfterMissionInit () {')[1]?.split('\n}')[0] ?? '';
  assert.match(restore, /GameA_PreparationOptionsApplyDifficulty\(\)/);
  assert.match(restore, /gameA_selectedDifficulty >= 3[\s\S]*c_gameSpeedFaster[\s\S]*c_gameSpeedFast/);
  assert.match(restore, /libCOMI_gf_CM_DifficultyApplySettings\(1\)/);
  assert.match(restore, /libCOMI_gf_CM_DifficultyApplySettings\(2\)/);
  assert.match(restore, /libCOUI_gf_CU_PrestigeBriefInit\(1, 2\)/);

  const before = adapter.indexOf('GameA_GeneratedBeforeMissionStart()');
  const mission = adapter.indexOf('TriggerExecute(missionStart, true, false)');
  const after = adapter.indexOf('GameA_GeneratedPostMissionStart()');
  assert.ok(before >= 0 && before < mission && mission < after);
});

test('host delegates optional post-start work and centralizes solo defeat compatibility', async () => {
  const coreRoot = path.join(root, 'game-a/core/GameA.SC2Mod');
  const [manifestText, adapter] = await Promise.all([
    readFile(path.join(coreRoot, 'GameA.Core.json'), 'utf8'),
    readFile(path.join(root, 'game-a/projects/GameA-OblivionExpress.SC2Map/scripts/GameAOblivionExpressAdapter.galaxy'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const testMode = manifest.galaxy.modules.find(candidate => candidate.path.endsWith('/TestMode.galaxy'));
  assert.equal(testMode?.postMissionStart, 'GameA_TestModeApplyStartingEconomy');
  assert.doesNotMatch(adapter, /GameA_TestModeApplyStartingEconomy\(\)/);

  const solo = adapter.split('void GameA_OblivionExpressKeepSoloSessionAlive () {')[1]?.split('\n}')[0] ?? '';
  assert.match(solo, /PlayerSetAlliance\(1, c_allianceIdDefeat, 2, false\)/);
  assert.match(solo, /PlayerSetAlliance\(2, c_allianceIdDefeat, 1, false\)/);
  assert.equal(adapter.match(/GameA_OblivionExpressKeepSoloSessionAlive\(\);/g)?.length, 2);
});
