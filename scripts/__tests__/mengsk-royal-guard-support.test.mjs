import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPlanToCore, treeHash, validateGalaxySource } from '../lib/patch-plan-executor.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sourceFile=path.join(root,'game-a/core/GameA.SC2Mod/Base.SC2Data/Generated/MengskRoyalGuardSupport.galaxy');

test('Mengsk support adapter recomputes the official term and adds a living-supply base term',async()=>{
  const source=await readFile(sourceFile,'utf8');
  assert.doesNotThrow(()=>validateGalaxySource(source,'MengskRoyalGuardSupport.galaxy'));
  assert.match(source,/basePerSupply == 0\.0/,'default zero exits without changing official behavior');
  assert.match(source,/GlobalCasterEnergyRegenCalculateRoyalGuard\(player\)/);
  assert.match(source,/basePerSupply \* masteryFactor \* GameA_MengskRoyalGuardLivingSupply\(player\)/);
  assert.match(source,/UnitIsAlive\(veteran\).*UnitGetOwner\(veteran\) == player/);
  assert.match(source,/libCOMI_gv_cM_Mengsk_EnergyRegenRoyalGuard \+= extraSupport/);
});

test('Mengsk support formula reaches all four requested ranks and scales the base with mastery',()=>{
  const perSupply=(rank,{coefficient=0.5,base=0,mastery=1}={})=>mastery*(coefficient*(1+rank)+base);
  assert.deepEqual([0,1,2,3].map(rank=>perSupply(rank)),[0.5,1,1.5,2]);
  assert.deepEqual([0,1,2,3].map(rank=>perSupply(rank,{base:0.5})),[1,1.5,2,2.5]);
  assert.deepEqual([0,1,2,3].map(rank=>Number(perSupply(rank,{base:0.5,mastery:1.2}).toFixed(6))),[1.2,1.8,2.4,3]);
  const units=[{supply:2,rank:0,alive:true},{supply:3,rank:2,alive:true},{supply:4,rank:3,alive:false}];
  assert.equal(units.filter(unit=>unit.alive).reduce((sum,unit)=>sum+unit.supply*perSupply(unit.rank,{base:0.5}),0),8);
});

test('the normal commander scalar operation edits the Mengsk base parameter idempotently',async()=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'mengsk-support-'));
  const coreRoot=path.join(temporary,'GameA.SC2Mod');
  try {
    await cp(path.join(root,'game-a/core/GameA.SC2Mod'),coreRoot,{recursive:true});
    const plan={formatVersion:2,id:'mengsk-royal-guard-base-support',operations:[{
      opId:'base-support',kind:'commander.stat.set',commanderId:'TerranMengsk',catalog:'Effect',
      object:'GameAMengskRoyalGuardBaseSupportPerSupply',path:'Amount',expect:0,value:0.5,
    }]};
    const first=await applyPlanToCore({coreRoot,plan});
    assert.equal(first.results[0].status,'changed');
    const upgrade=await readFile(path.join(coreRoot,'Base.SC2Data/GameData/UpgradeData.xml'),'utf8');
    assert.match(upgrade,/Reference="Effect,GameAMengskRoyalGuardBaseSupportPerSupply,Amount" Value="0\.5"/);
    const hash=await treeHash(coreRoot);
    const second=await applyPlanToCore({coreRoot,plan});
    assert.equal(second.results[0].status,'already');
    assert.equal(await treeHash(coreRoot),hash);
  } finally { await rm(temporary,{recursive:true,force:true}); }
});
