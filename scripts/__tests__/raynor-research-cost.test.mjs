import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPlanToCore, treeHash } from '../lib/patch-plan-executor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Raynor research cost hook is player-scoped and recalculates from unmodified defaults', async () => {
  const source = await readFile(path.join(root,
    'game-a/core/GameA.SC2Mod/Base.SC2Data/Generated/RaynorResearchCost.galaxy'), 'utf8');
  assert.match(source, /"GameARaynorResearchCostPerPoint", "Amount", player/);
  assert.match(source, /changedFactor = 1\.0 - IntToFixed\(level\) \* perPoint/);
  assert.match(source, /"AffectedUnitArray\[" \+ IntToString\(researchIndex\)/);
  assert.match(source, /defaultCost = .*c_playerAny\);/);
  assert.match(source, /CeilingI\(defaultCost \* changedFactor\)/);
  assert.match(source, /void GameA_RaynorResearchCostApplyConfiguredPlayers \(\)/);
  assert.doesNotMatch(source, /defaultCost = .*player\);/);
  const manifest = JSON.parse(await readFile(path.join(root,
    'game-a/core/GameA.SC2Mod/GameA.Core.json'), 'utf8'));
  const module = manifest.galaxy.modules.find(candidate => candidate.path.endsWith('/RaynorResearchCost.galaxy'));
  assert.equal(module?.postMissionStart, 'GameA_RaynorResearchCostApplyConfiguredPlayers');
  const adapter = await readFile(path.join(root,
    'game-a/projects/GameA-OblivionExpress.SC2Map/scripts/GameAOblivionExpressAdapter.galaxy'), 'utf8');
  assert.ok(adapter.indexOf('GameA_GeneratedPostMissionStart()')
    > adapter.indexOf('TriggerExecute(missionStart, true, false)'));
  assert.doesNotMatch(adapter, /GameA_RaynorResearchCostApplyConfiguredPlayers/);
});

test('Raynor representative costs use the independent coefficient without compounding', () => {
  const cost = (base, level, perPoint) => {
    const rateUnits = Math.round(perPoint * 1_000_000);
    return Math.ceil(base * (1_000_000 - level * rateUnits) / 1_000_000);
  };
  assert.deepEqual([0, 1, 10, 30].map(level => cost(100, level, 0.03)), [100, 97, 70, 10]);
  assert.equal(cost(0, 30, 0.03), 0);
  assert.equal(cost(175, 30, 0.03), 18);
});

test('the existing commander stat operation edits only Raynor parameter state and is idempotent', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'raynor-cost-'));
  const sourceCore = path.join(root, 'game-a/core/GameA.SC2Mod');
  const coreRoot = path.join(temporary, 'GameA.SC2Mod');
  try {
    await cp(sourceCore, coreRoot, { recursive: true });
    const plan = { formatVersion: 2, id: 'raynor-cost-three-percent', operations: [{
      opId: 'raynor-cost-per-point', kind: 'commander.stat.set', commanderId: 'TerranRaynor',
      catalog: 'Effect', object: 'GameARaynorResearchCostPerPoint', path: 'Amount', expect: 0.02, value: 0.03,
    }] };
    const first = await applyPlanToCore({ coreRoot, plan });
    assert.equal(first.results[0].status, 'changed');
    const upgrade = await readFile(path.join(coreRoot, 'Base.SC2Data/GameData/UpgradeData.xml'), 'utf8');
    const manifest = await readFile(path.join(coreRoot, 'GameA.Core.json'), 'utf8');
    assert.match(upgrade, /Reference="Effect,GameARaynorResearchCostPerPoint,Amount" Value="0\.03"/);
    assert.match(manifest, /CommanderUpgrade_[a-f0-9]{16}\.galaxy/);
    const firstHash = await treeHash(coreRoot);
    const second = await applyPlanToCore({ coreRoot, plan });
    assert.equal(second.results[0].status, 'already');
    assert.equal(await treeHash(coreRoot), firstHash);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
