import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const plan = JSON.parse(readFileSync(new URL('../../game-a/patches/game-a-test-mode-unit-production-10s.patch-plan.json', import.meta.url), 'utf8'));
const upgradeId = 'GameATestModeUnitProduction10';
const effects = plan.operations.filter(op => op.kind === 'catalog.insert' && op.object === upgradeId);
const values = new Map(effects.map(op => [op.attributes.Reference, op.attributes.Value]));
const runtime = plan.operations.find(op => op.kind === 'galaxy.source').source;

test('test-mode production effects are unique, explicit 10-second Set operations', () => {
  assert(effects.length > 500);
  assert.equal(values.size, effects.length);
  for (const op of effects) {
    assert.equal(op.attributes.Operation, 'Set');
    assert.equal(op.attributes.Value, 10);
    assert.match(op.attributes.Reference, /^Abil,[^,]+,InfoArray\[/);
  }
});

test('normal training, warp-in and zerg production morphs are covered', () => {
  for (const reference of [
    'Abil,BarracksTrain,InfoArray[Train1].Time',
    'Abil,FactoryTrain,InfoArray[Train2].Time',
    'Abil,WarpGateTrain,InfoArray[Train1].Time',
    'Abil,LarvaTrainStetmann,InfoArray[Train1].Time',
    'Abil,MorphToBaneling,InfoArray[1].SectionArray[Stats].DurationArray[Delay]',
    'Abil,MorphToLurkerStetmann,InfoArray[1].SectionArray[Stats].DurationArray[Delay]',
  ]) assert.equal(values.get(reference), 10, reference);
});

test('Nova and Horner initial/replenishment charge times are covered', () => {
  for (const [ability, slots] of [
    ['BarracksTrainNova', 3], ['FactoryTrainNova', 3],
    ['StarportTrainNova', 4], ['HHStarportTrainHorner', 4],
  ]) {
    for (let slot = 1; slot <= slots; slot++) {
      for (const timer of ['TimeStart', 'TimeUse']) {
        const reference = `Abil,${ability},InfoArray[Train${slot}].Charge.${timer}`;
        assert.equal(values.get(reference), 10, reference);
      }
    }
  }
});

test('stock counts, costs, requirements, research and ordinary spell cooldowns are not changed', () => {
  for (const reference of values.keys()) {
    assert.doesNotMatch(reference, /CountMax|CountStart|CountUse|Resource|Requirements|StimPack|Blink|Research/);
    assert.match(reference, /\.(?:Time|Charge\.Time(?:Start|Use)|Cooldown\.Time(?:Start|Use)|SectionArray\[[^\]]+\]\.DurationArray\[[^\]]+\])$/);
  }
  assert(![...values.keys()].some(ref => /Tychus(?:Barracks|Factory)Train,.*Charge\./.test(ref)), 'capacity-only outlaw slots must not gain recharge');
});

test('production upgrade is conditional, commander-player-only, non-stacking and applied before initial units', () => {
  const configure = runtime.split('void GameA_TestModeConfigureProduction () {')[1].split('\nvoid ')[0];
  assert.match(configure, /if \(!gameA_testModeEnabled\)\s*\{\s*return;/);
  assert.match(configure, /commanders = libCOOC_gf_CommanderPlayers\(\);/);
  assert.match(configure, /PlayerGroupNextPlayer\(commanders, player\)/);
  assert.match(configure, /SetUpgradeLevelForPlayer\(player, "GameATestModeUnitProduction10", 1\)/);
  assert.doesNotMatch(configure, /TechTreeUpgradeAddLevel/);
  assert(plan.operations.some(op => op.kind === 'file.patch' && op.path === 'GameA.Core.json'
    && op.patch.includes('"configure": "GameA_TestModeConfigureProduction"') && op.baseSha256));
});

test('legacy one-second structure completion cannot force-complete warp-trained units', () => {
  const handler = runtime.split('bool GameA_TestModeOnConstructionStarted')[1].split('\nvoid ')[0];
  const guard = handler.indexOf('!UnitTypeTestAttribute(EventUnitProgressObjectType(), c_unitAttributeStructure)');
  assert(guard >= 0);
  assert(guard < handler.indexOf('Wait(1.0, c_timeGame)'));
  assert.match(handler.slice(guard), /c_unitAttributeStructure\)\)\s*\{\s*return true;/);
});
