// Hand-reviewed navigation rules, not extracted values or a prebuilt database.
// Each rule selects only known IDs on the reviewed build. It does NOT prove
// activation, full perk coverage, or that these are safe direct edit targets.
const rule=(commanderId,entryId,targets,note='Only the listed portion of this perk is mapped; activation and other effects remain unverified.')=>({
  ruleId:`reviewed/${entryId}/v1`,commanderId,entryId,reviewedBuild:'B97579',
  targets:targets.map(s=>{if(typeof s!=='string') return s; const [catalog,objectId]=s.split('/');return {catalog,objectId};}),note,
});
const stet=(level,targets,note)=>rule('ZergStetmann',`CommanderStetmannLevel${String(level).padStart(2,'0')}`,targets,note);
const mengsk=(level,targets)=>rule('TerranMengsk',`CommanderMengskLevel${String(level).padStart(2,'0')}`,targets);
const zeratul=(level,targets)=>rule('ProtossZeratul',`CommanderZeratulLevel${String(level).padStart(2,'0')}`,targets);
export const REVIEWED_COOP_LINKS=[
  rule('ProtossArtanis','CommanderArtanisSwiftRetribution',['Upgrade/ArtanisCommander'],
    'Warp production time parameters are mixed with unrelated commander modifications; do not edit the whole Upgrade.'),
  rule('TerranTychus','CommanderTychusLevel01',['Abil/TychusReviveHeroes'],
    'Revival cost/time only. First recruitment, outlaw limits, supply and the death escape mechanism remain separate.'),
  rule('ZergDehaka','CommanderDehakaBaseTrait',['Abil/DehakaRevive','Abil/DehakaCoopReviveEat'],
    'Revival and drone-consumption entrypoints only; essence growth and its complete formula are not resolved.'),
  rule('ZergStukov','CommanderStukovAutoCreep',['Behavior/SICivilianStructureSpawnCivilian','Abil/SICivilianStructureSpawnCivilian'],
    'Automatic civilian spawn subset only. Starting structure grant and creep expansion remain separate.'),
  rule('ProtossAlarak','CommanderAlarakStrongestSurvive',['Behavior/AlarakTheStrongestSurvive']),
  rule('ProtossAlarak','CommanderAlarakForgeAlarakUpgrades',['Upgrade/AlarakAttackStunUpgrade','Upgrade/AlarakDestructionWaveDistance']),
  rule('ProtossFenix','CommanderFenixBaseTrait',['Abil/SOASummonFenix','Abil/SOASummonFenixArbiter','Abil/SOASummonFenixDragoon'],
    'Suit deployment entrypoints only; offline regeneration and unit discount are not fully mapped.'),
  rule('ProtossFenix','CommanderFenixUnlockPurifierConclave',[
    {catalog:'Abil',objectId:'FenixAltarOfPsiStormsResearch',commandIndex:'Research1',expectedUpgrade:'FenixChampionKaldalisZealot'},
    {catalog:'Abil',objectId:'FenixAltarOfPsiStormsResearch',commandIndex:'Research2',expectedUpgrade:'FenixChampionTalisAdept'},
    'Upgrade/FenixChampionKaldalisZealot','Upgrade/FenixChampionTalisAdept']),
  rule('ProtossKarax','CommanderKaraxOrbitalAssault',['Upgrade/KaraxCommander'],
    'Commander-wide Upgrade contains the unit health/cost part as well as unrelated changes. Orbital Strike activation is not mapped here.'),
  rule('ProtossVorazun','CommanderVorazunShadowStalk',['Upgrade/VorazunCommander'],
    'Commander-wide Upgrade contains the Dark Templar shield part as well as unrelated changes; gas-cost composition remains unverified.'),
  rule('TerranSwann','CommanderSwannVehicleSpecialist',['Upgrade/SwannCommander'],
    'Factory/Armory gas field changes are located here. Production speed and unrelated commander changes must be distinguished.'),
  rule('ZergKerrigan','CommanderKerriganMutatingCarapace',['Behavior/KerriganAssimilationLifesteal','Behavior/KerriganAssimilationShieldDegen','Behavior/KerriganNormalReviveTimer']),
  rule('ZergDehaka','CommanderDehakaLevel15',['Behavior/DehakaGeneAttackSpeed','Behavior/DehakaGeneCarapace','Behavior/DehakaGeneLifeLeech'],
    'Mutation bonuses only; mutation chance and other mutation outcomes are not evaluated.'),
  rule('ZergZagara','CommanderZagaraRelentless',['Upgrade/ZagaraCommander'],
    'Training-time and supply-field subset only; commander initialization, caps and spawn multiplicity remain unverified.'),
  zeratul(3,['Upgrade/ZeratulArtifactTier2_CyberneticsCore']),
  zeratul(4,['Unit/ZeratulDisruptor']),
  zeratul(5,[{catalog:'Abil',objectId:'ZeratulTopBarBuild',commandIndex:'Build1',expectedUnit:'ZeratulKhaydarinMonolith'}]),
  zeratul(6,['Upgrade/ZeratulArtifactTier2_RoboticsBay']),
  zeratul(7,['Abil/ZeratulSuppressionCrystal']),
  zeratul(8,['Abil/ZeratulDarkArchonMaelstrom']),
  zeratul(9,['Unit/ZeratulWarpPrism']),
  zeratul(13,['Upgrade/ZeratulArtifactTier3_RoboticsBay']),
  zeratul(15,['Upgrade/ZeratulArtifactTier1ZeratulTalentUpgrade','Upgrade/ZeratulArtifactTier2ZeratulTalentUpgrade','Upgrade/ZeratulArtifactTier3ZeratulTalentUpgrade']),
  mengsk(1,['Unit/SCVMengsk','Unit/TrooperMengsk']),
  mengsk(2,['Abil/TrooperMengskSpecializeAA','Abil/TrooperMengskSpecializeFlamethrower']),
  mengsk(3,['Unit/ArtilleryMengsk']),
  mengsk(4,['Abil/ArtilleryMengskExperimentalStrike','Abil/ArtilleryMengskGlobalExperimentalStrike']),
  mengsk(6,['Upgrade/BunkerDepotMengskRange','Upgrade/ArtilleryMengskRange']),
  mengsk(7,['Abil/MengskZergCalldownLevel3','Abil/MengskZergCalldownLevel4']),
  mengsk(8,['Upgrade/MarauderMengskSlow','Upgrade/MedivacMengskSiegeTankAirlift','Upgrade/VikingMengskSpeed']),
  mengsk(9,['Unit/ThorMengsk']),
  mengsk(10,['Abil/NuclearAnnihilationMengsk']),
  mengsk(12,['Unit/BattlecruiserMengsk']),
  mengsk(14,['Upgrade/GhostMengskGuidedStrike','Upgrade/ThorMengskArmorAura','Upgrade/BattlecruiserMengskRangeAura']),
  mengsk(15,['Abil/MarauderMengskAttackSpeedBoost','Abil/GhostMengskEMPBig','Abil/GhostMengskIrradiateBigDamage']),
  stet(1,['Abil/DeployPowerTowerStetmann','Behavior/PowerFieldBuffSelfStetmann','Behavior/PowerFieldBuffAllyStetmann','Behavior/SpawnLarvaStetmann']),
  stet(2,['Behavior/PowerFieldBuffSelfStetmann','Behavior/PowerFieldBuffAllyStetmann'],
    'Shared Stetzone behavior candidates include other modes; select the energy-mode fields/conditions, not all modes.'),
  stet(3,['Abil/GaryStetmannPowerTowerOverchargeEnergy','Abil/GaryStetmannPowerTowerOverchargeHealth','Abil/GaryStetmannPowerTowerOverchargeSpeed']),
  stet(4,['Upgrade/ZerglingStetmannAttackSpeed','Upgrade/BanelingStetmannExtraDamage','Upgrade/BanelingStetmannManaShieldBonus']),
  stet(5,['Abil/MorphToSuperGaryStetmann','Unit/SuperGaryStetmann','Behavior/SuperGaryStetmannTheBestOil']),
  stet(6,['Unit/LurkerStetmann','Abil/MorphToLurkerStetmann']),
  stet(7,['Abil/DeployPowerTowerStetmann','Effect/LairHiveStetmannTrigger'],
    'Lair/Hive-dependent charge mechanism entrypoints; runtime charge mutation is not evaluated.'),
  stet(8,['Upgrade/HydraliskStetmannRange','Upgrade/LurkerStetmannChannelingSpines']),
  stet(9,['Effect/StetmannUnitDeathFindPickupUnitSearch','Effect/StetmannUnitDeathSwitch'],
    'Parts pickup and death-routing entrypoints only, not a proven complete reconstruction formula.'),
  stet(10,['Upgrade/InfestorStetmannRecharge','Upgrade/InfestorStetmannBonusRavager']),
  stet(11,['Unit/BroodLordStetmann']),
  stet(12,['Upgrade/UltraliskStetmannMechanicalLifeLeech','Upgrade/UltraliskStetmannArmor']),
  stet(13,['Effect/ZerglingStetmannDeathRespawnAddCharge'],
    'Parts count route candidate; level-dependent multiplicity is not evaluated.'),
  stet(14,['Upgrade/CorruptorStetmannCausticSpray','Upgrade/BroodLordStetmannBombers','Upgrade/BroodLordStetmannYamato']),
  stet(15,['Behavior/StetmannBuildingDoubleQueue'],
    'This is a queue restriction REMOVED by HasStetmannLevel15, not the granted queue size. Inspect RemoveValidatorArray before changing it.'),
];

export function applyReviewedLinks(db,commanderId,profile,rules=REVIEWED_COOP_LINKS) {
  const build=db.prepare("SELECT value FROM main.meta WHERE key='sc2Build'").get()?.value;
  const exists=db.prepare('SELECT class FROM main.catalog_objects WHERE catalog=? AND object_id=?');
  const field=db.prepare('SELECT path,value FROM main.catalog_fields WHERE catalog=? AND object_id=?');
  for(const item of profile.levelPerks ?? []) for(const r of rules.filter(r=>r.commanderId===commanderId && r.entryId===item.id)) {
    const missing=r.targets.filter(t=>!exists.get(t.catalog,t.objectId) || (t.expectedUpgrade || t.expectedUnit) && !field.all(t.catalog,t.objectId)
      .some(f=>f.path.replaceAll('.@','.').replaceAll('[#','[')===`InfoArray[${t.commandIndex}].${t.expectedUpgrade?'Upgrade':'Unit'}` && f.value===(t.expectedUpgrade ?? t.expectedUnit)));
    const enabled=build===r.reviewedBuild && !missing.length && Boolean(exists.get('Button',item.id));
    item.reviewedRules=(item.reviewedRules ?? []).filter(x=>x.ruleId!==r.ruleId);
    item.links=(item.links ?? []).filter(t=>t.evidence?.ruleId!==r.ruleId);
    item.reviewedRules.push({ruleId:r.ruleId,reviewedBuild:r.reviewedBuild,status:enabled?'applied-partial':'guard-failed',
      note:r.note,...(!enabled?{reason:build!==r.reviewedBuild?'unreviewed-build':missing.length?'missing-target':'missing-presentation',missingTargets:missing}:{}),
      runtimeEvaluated:false});
    if(enabled) item.links=[...(item.links ?? []),...r.targets.map(t=>({...t,role:'reviewed-partial-mechanism',
      evidence:{ruleId:r.ruleId,reviewedBuild:r.reviewedBuild,presentation:{catalog:'Button',objectId:item.id},note:r.note}}))];
  }
  return profile;
}
