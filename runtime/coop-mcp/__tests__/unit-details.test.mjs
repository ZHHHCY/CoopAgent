import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { buildUnitDetails, buildUnitProjection } from "../lib/unit-details.mjs";

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schemaVersion', '2'), ('sc2Build', 'BTEST');

    CREATE TABLE catalog_definitions (
      id INTEGER PRIMARY KEY,
      load_order INTEGER NOT NULL,
      catalog TEXT NOT NULL,
      class TEXT NOT NULL,
      object_id TEXT NOT NULL,
      parent_id TEXT,
      is_default INTEGER NOT NULL,
      source_file TEXT NOT NULL,
      xml TEXT NOT NULL
    );
    CREATE TABLE catalog_objects (
      catalog TEXT NOT NULL,
      object_id TEXT NOT NULL,
      class TEXT NOT NULL,
      parent_id TEXT,
      is_default INTEGER NOT NULL,
      source_file TEXT NOT NULL,
      direct_xml TEXT NOT NULL,
      PRIMARY KEY(catalog, object_id)
    ) WITHOUT ROWID;
    CREATE TABLE catalog_fields (
      catalog TEXT NOT NULL,
      object_id TEXT NOT NULL,
      path TEXT NOT NULL,
      value TEXT NOT NULL,
      field_tag TEXT NOT NULL,
      attribute TEXT,
      source_file TEXT NOT NULL,
      origin_object_id TEXT NOT NULL,
      inheritance_depth INTEGER NOT NULL,
      PRIMARY KEY(catalog, object_id, path)
    ) WITHOUT ROWID;
    CREATE TABLE object_references (
      source_catalog TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      target_catalog TEXT NOT NULL,
      target_object_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence TEXT NOT NULL,
      PRIMARY KEY(source_catalog, source_object_id, field_path, target_catalog, target_object_id)
    ) WITHOUT ROWID;
    CREATE TABLE localized_text (
      locale TEXT NOT NULL,
      text_key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_file TEXT NOT NULL,
      PRIMARY KEY(locale, text_key)
    ) WITHOUT ROWID;
    CREATE TABLE commanders (
      id TEXT PRIMARY KEY,
      commander_object_id TEXT NOT NULL,
      user_reference TEXT,
      name_key TEXT,
      name_zhcn TEXT,
      name_enus TEXT
    );
    CREATE TABLE commander_profiles (
      commander_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL
    );
    CREATE TABLE commander_membership (
      commander_id TEXT NOT NULL,
      catalog TEXT NOT NULL,
      object_id TEXT NOT NULL,
      evidence TEXT NOT NULL,
      depth INTEGER NOT NULL,
      PRIMARY KEY(commander_id, catalog, object_id, evidence)
    ) WITHOUT ROWID;
  `);

  const definitions = [
    ["Unit", "UnitAlpha", "CUnit"],
    ["Unit", "UnitBeta", "CUnit"],
    ["Weapon", "@default:CWeapon", "CWeapon"],
    ["Weapon", "AlphaRifle", "CWeaponLegacy"],
    ["Weapon", "BetaFlamer", "CWeaponLegacy"],
    ["Effect", "AlphaRifleDamage", "CEffectDamage"],
    ["Effect", "BetaLaunch", "CEffectLaunchMissile"],
    ["Effect", "BetaSet", "CEffectSet"],
    ["Effect", "BetaDamage", "CEffectDamage"],
    ["Effect", "BetaCycle", "CEffectSet"],
    ["Abil", "move", "CAbilMove"],
    ["Abil", "stop", "CAbilStop"],
    ["Abil", "attack", "CAbilAttack"],
    ["Abil", "AlphaStim", "CAbilEffectInstant"],
    ["Abil", "AlphaHidden", "CAbilEffectInstant"],
    ["Abil", "BetaBurst", "CAbilEffectTarget"],
    ["Button", "Move", "CButton"],
    ["Button", "AlphaStimButton", "CButton"],
    ["Button", "BetaBurstButton", "CButton"],
    ["Button", "OwnPassiveButton", "CButton"],
    ["Button", "ForeignProtocolButton", "CButton"],
    ["Requirement", "HaveOwnPassive", "CRequirement"],
    ["Requirement", "CountOwnUpgrade", "CRequirementCountUpgrade"],
    ["Requirement", "HaveForeignProtocol", "CRequirement"],
    ["Requirement", "CountForeignUpgrade", "CRequirementCountUpgrade"],
    ["Upgrade", "OwnUpgrade", "CUpgrade"],
    ["Upgrade", "ForeignUpgrade", "CUpgrade"],
  ];
  const insertDefinition = database.prepare(`
    INSERT INTO catalog_definitions(
      load_order, catalog, class, object_id, parent_id, is_default, source_file, xml
    ) VALUES (?, ?, ?, ?, NULL, ?, 'fixture:data.xml', '<Object/>')
  `);
  const insertObject = database.prepare(`
    INSERT INTO catalog_objects(
      catalog, object_id, class, parent_id, is_default, source_file, direct_xml
    ) VALUES (?, ?, ?, NULL, ?, 'fixture:data.xml', '<Object/>')
  `);
  definitions.forEach(([catalog, objectId, className], index) => {
    const isDefault = objectId.startsWith("@default:") ? 1 : 0;
    insertDefinition.run(index, catalog, className, objectId, isDefault);
    insertObject.run(catalog, objectId, className, isDefault);
  });

  const insertField = database.prepare(`
    INSERT INTO catalog_fields(
      catalog, object_id, path, value, field_tag, attribute,
      source_file, origin_object_id, inheritance_depth
    ) VALUES (?, ?, ?, ?, ?, ?, 'fixture:data.xml', ?, ?)
  `);
  function field(catalog, objectId, fieldPath, value, options = {}) {
    const finalSegment = fieldPath.split(".").at(-1) ?? fieldPath;
    const fieldTag = finalSegment.replace(/^@/, "").replace(/\[.*$/, "") || "Value";
    const attribute = finalSegment.startsWith("@") ? finalSegment.slice(1) : null;
    insertField.run(
      catalog,
      objectId,
      fieldPath,
      String(value),
      fieldTag,
      attribute,
      options.originObjectId ?? objectId,
      options.inheritanceDepth ?? 0,
    );
  }

  field("Weapon", "@default:CWeapon", "Range", 5);
  field("Weapon", "@default:CWeapon", "DamagePoint", 0.167);

  field("Unit", "UnitAlpha", "WeaponArray.@Link", "AlphaRifle");
  field("Unit", "UnitAlpha", "AbilArray[#0].@Link", "move");
  field("Unit", "UnitAlpha", "AbilArray[#1].@Link", "stop");
  field("Unit", "UnitAlpha", "AbilArray[#2].@Link", "attack");
  field("Unit", "UnitAlpha", "AbilArray[#3].@Link", "AlphaStim");
  field("Unit", "UnitAlpha", "AbilArray[#4].@Link", "AlphaHidden");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#0].@Type", "AbilCmd");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#0].@AbilCmd", "move,Move");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#0].@Face", "Move");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#1].@Type", "AbilCmd");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#1].@AbilCmd", "AlphaStim,Execute");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#1].@Face", "AlphaStimButton");
  // The effective Catalog can contain the same semantic button through keyed
  // and ordinal array paths. The result must describe it only once.
  field("Unit", "UnitAlpha", "CardLayouts[0].LayoutButtons[1].Type", "AbilCmd", {
    inheritanceDepth: 1,
  });
  field("Unit", "UnitAlpha", "CardLayouts[0].LayoutButtons[1].AbilCmd", "AlphaStim,Execute", {
    inheritanceDepth: 1,
  });
  field("Unit", "UnitAlpha", "CardLayouts[0].LayoutButtons[1].Face", "AlphaStimButton", {
    inheritanceDepth: 1,
  });
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#2].Type", "Passive");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#2].AbilCmd", "255");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#2].Face", "OwnPassiveButton");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#2].Requirements", "HaveOwnPassive");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#3].@Type", "Passive");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#3].@AbilCmd", "255");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#3].@Face", "ForeignProtocolButton");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#3].@Requirements", "HaveForeignProtocol");

  field("Unit", "UnitBeta", "WeaponArray[#0].@Link", "BetaFlamer");
  field("Unit", "UnitBeta", "AbilArray[#0].@Link", "move");
  field("Unit", "UnitBeta", "AbilArray[#1].@Link", "BetaBurst");
  field("Unit", "UnitBeta", "CardLayouts[#0].LayoutButtons[#0].@Type", "AbilCmd");
  field("Unit", "UnitBeta", "CardLayouts[#0].LayoutButtons[#0].@AbilCmd", "BetaBurst,Execute");
  field("Unit", "UnitBeta", "CardLayouts[#0].LayoutButtons[#0].@Face", "BetaBurstButton");

  field("Weapon", "AlphaRifle", "Effect", "##id##Damage");
  field("Weapon", "AlphaRifle", "Period", 1.5);
  field("Weapon", "AlphaRifle", "TargetFilters", "Ground,Visible;Missile,Stasis,Dead,Hidden");
  field("Effect", "AlphaRifleDamage", "Amount", 6);

  field("Weapon", "BetaFlamer", "Effect", "BetaLaunch");
  field("Weapon", "BetaFlamer", "Period", 2);
  field("Weapon", "BetaFlamer", "Range", 7);
  field("Weapon", "BetaFlamer", "DamagePoint", 0.2);
  field("Weapon", "BetaFlamer", "TargetFilters", "Air,Visible;Missile,Stasis,Dead,Hidden");
  field("Effect", "BetaLaunch", "ImpactEffect", "BetaSet");
  field("Effect", "BetaSet", "EffectArray[#0]", "BetaDamage");
  field("Effect", "BetaSet", "EffectArray[#1]", "BetaCycle");
  field("Effect", "BetaDamage", "Amount", 12);
  field("Effect", "BetaCycle", "EffectArray[#0]", "BetaSet");

  field("Requirement", "HaveOwnPassive", "NodeArray[Use].@Link", "CountOwnUpgrade");
  field("Requirement", "CountOwnUpgrade", "Count.@Link", "OwnUpgrade");
  field("Requirement", "HaveForeignProtocol", "NodeArray[Use].@Link", "CountForeignUpgrade");
  field("Requirement", "CountForeignUpgrade", "Count.@Link", "ForeignUpgrade");

  const insertReference = database.prepare(`
    INSERT INTO object_references(
      source_catalog, source_object_id, field_path, target_catalog,
      target_object_id, confidence, evidence
    ) VALUES (?, ?, ?, ?, ?, 1.0, ?)
  `);
  function reference(sourceCatalog, sourceId, fieldPath, targetCatalog, targetId) {
    insertReference.run(
      sourceCatalog,
      sourceId,
      fieldPath,
      targetCatalog,
      targetId,
      `fixture:${fieldPath}`,
    );
  }
  reference("Unit", "UnitAlpha", "WeaponArray.@Link", "Weapon", "AlphaRifle");
  reference("Unit", "UnitAlpha", "AbilArray[#3].@Link", "Abil", "AlphaStim");
  reference("Unit", "UnitAlpha", "AbilArray[#4].@Link", "Abil", "AlphaHidden");
  reference("Unit", "UnitBeta", "WeaponArray[#0].@Link", "Weapon", "BetaFlamer");
  reference("Unit", "UnitBeta", "AbilArray[#1].@Link", "Abil", "BetaBurst");
  reference("Weapon", "AlphaRifle", "Effect", "Effect", "AlphaRifleDamage");
  reference("Weapon", "BetaFlamer", "Effect", "Effect", "BetaLaunch");
  reference("Effect", "BetaLaunch", "ImpactEffect", "Effect", "BetaSet");
  reference("Effect", "BetaSet", "EffectArray[#0]", "Effect", "BetaDamage");
  reference("Effect", "BetaSet", "EffectArray[#1]", "Effect", "BetaCycle");
  reference("Effect", "BetaCycle", "EffectArray[#0]", "Effect", "BetaSet");
  reference("Requirement", "HaveOwnPassive", "NodeArray[Use].@Link", "Requirement", "CountOwnUpgrade");
  reference("Requirement", "CountOwnUpgrade", "Count.@Link", "Upgrade", "OwnUpgrade");
  reference("Requirement", "HaveForeignProtocol", "NodeArray[Use].@Link", "Requirement", "CountForeignUpgrade");
  reference("Requirement", "CountForeignUpgrade", "Count.@Link", "Upgrade", "ForeignUpgrade");

  const insertText = database.prepare(
    "INSERT INTO localized_text(locale, text_key, value, source_file) VALUES (?, ?, ?, 'fixture:gamestrings.txt')",
  );
  for (const [key, value] of [
    ["Weapon/Name/AlphaRifle", "阿尔法步枪 /// Alpha Rifle"],
    ["Weapon/Name/BetaFlamer", "贝塔火焰炮"],
    ["Button/Name/AlphaStimButton", "阿尔法强化剂"],
    ["Button/Tooltip/AlphaStimButton", "提高阿尔法单位的作战能力。"],
    ["Button/Name/BetaBurstButton", "贝塔爆发"],
    ["Button/Tooltip/BetaBurstButton", "对目标发动一次爆发。"],
    ["Button/Name/OwnPassiveButton", "本指挥官被动"],
    ["Button/Tooltip/OwnPassiveButton", "属于测试指挥官。"],
    ["Button/Name/ForeignProtocolButton", "外来协议"],
    ["Button/Tooltip/ForeignProtocolButton", "只属于另一个指挥官。"],
  ]) {
    insertText.run("zhcn", key, value);
  }

  database.exec(`
    INSERT INTO commanders VALUES
      ('TerranFixture', 'Fixture', 'PlayerCommanders;TerranFixture', NULL, '测试指挥官', 'Fixture'),
      ('TerranForeign', 'Foreign', 'PlayerCommanders;TerranForeign', NULL, '外部指挥官', 'Foreign');

    INSERT INTO commander_membership VALUES
      ('TerranFixture', 'Unit', 'UnitAlpha', 'typed-userdata:Commander.UnitArray', 0),
      ('TerranFixture', 'Unit', 'UnitBeta', 'typed-userdata:Commander.UnitArray', 0),
      ('TerranFixture', 'Weapon', 'AlphaRifle', 'reference-depth:1', 1),
      ('TerranFixture', 'Weapon', 'BetaFlamer', 'reference-depth:1', 1),
      ('TerranFixture', 'Abil', 'AlphaStim', 'reference-depth:1', 1),
      ('TerranFixture', 'Abil', 'BetaBurst', 'reference-depth:1', 1),
      ('TerranFixture', 'Button', 'OwnPassiveButton', 'typed-userdata:Button', 0),
      ('TerranFixture', 'Upgrade', 'OwnUpgrade', 'typed-userdata:Upgrade', 0),
      ('TerranFixture', 'Button', 'ForeignProtocolButton', 'reference-depth:1', 1),
      ('TerranFixture', 'Upgrade', 'ForeignUpgrade', 'reference-depth:2', 2),
      ('TerranForeign', 'Button', 'ForeignProtocolButton', 'typed-userdata:Button', 0),
      ('TerranForeign', 'Upgrade', 'ForeignUpgrade', 'typed-userdata:Upgrade', 0);
  `);

  const insertProfile = database.prepare(
    "INSERT INTO commander_profiles(commander_id, profile_json) VALUES (?, ?)",
  );
  insertProfile.run("TerranFixture", JSON.stringify({
    roster: {
      units: [
        { techId: "UnitAlpha", unitId: "UnitAlpha", source: "Commander.UnitArray" },
        { techId: "UnitBeta", unitId: "UnitBeta", source: "Commander.UnitArray" },
      ],
      buildings: [],
    },
    levelPerks: [{ level: 2, id: "OwnUpgrade" }],
    prestiges: [],
    masteries: [],
    panel: { traits: [], casterUnit: null, abilityCommands: [], defaultUpgrades: [] },
  }));
  insertProfile.run("TerranForeign", JSON.stringify({
    roster: { units: [], buildings: [] },
    levelPerks: [{ level: 3, id: "ForeignUpgrade" }],
    prestiges: [],
    masteries: [],
    panel: { traits: [], casterUnit: null, abilityCommands: [], defaultUpgrades: [] },
  }));

  return database;
}

function addResearchRegressionFixture(database) {
  const definitions = [
    [200, "Abil", "FixtureResearch", "CAbilResearch"],
    [201, "Abil", "RestrictedBlast", "CAbilEffectInstant"],
    [202, "Button", "SlotZeroResearchButton", "CButton"],
    [203, "Button", "OwnResearchButton", "CButton"],
    [204, "Button", "OwnResearchPassive", "CButton"],
    [205, "Button", "ForeignResearchButton", "CButton"],
    [206, "Button", "ForeignResearchPassive", "CButton"],
    [207, "Button", "RestrictedBlastButton", "CButton"],
    [208, "Button", "FixtureResearchPackButton", "CButton"],
    [209, "Button", "RestrictedBlastPerkButton", "CButton"],
    [210, "Requirement", "HaveSlotZeroResearch", "CRequirement"],
    [211, "Requirement", "CountSlotZeroUpgrade", "CRequirementCountUpgrade"],
    [212, "Requirement", "HaveOwnResearch", "CRequirement"],
    [213, "Requirement", "CountOwnResearchUpgrade", "CRequirementCountUpgrade"],
    [214, "Requirement", "HaveForeignResearch", "CRequirement"],
    [215, "Requirement", "CountForeignResearchUpgrade", "CRequirementCountUpgrade"],
    [216, "Upgrade", "SlotZeroUpgrade", "CUpgrade"],
    [217, "Upgrade", "OwnResearchUpgrade", "CUpgrade"],
    [218, "Upgrade", "ForeignSharedUpgrade", "CUpgrade"],
    [219, "Upgrade", "UnlockRestrictedBlast", "CUpgrade"],
  ];
  const insertDefinition = database.prepare(`
    INSERT INTO catalog_definitions(
      id, load_order, catalog, class, object_id, parent_id,
      is_default, source_file, xml
    ) VALUES (?, ?, ?, ?, ?, NULL, 0, 'fixture:research.xml', '<Object/>')
  `);
  const insertObject = database.prepare(`
    INSERT INTO catalog_objects(
      catalog, object_id, class, parent_id, is_default, source_file, direct_xml
    ) VALUES (?, ?, ?, NULL, 0, 'fixture:research.xml', '<Object/>')
  `);
  for (const [id, catalog, objectId, className] of definitions) {
    insertDefinition.run(id, id, catalog, className, objectId);
    insertObject.run(catalog, objectId, className);
  }

  const insertField = database.prepare(`
    INSERT INTO catalog_fields(
      catalog, object_id, path, value, field_tag, attribute,
      source_file, origin_object_id, inheritance_depth
    ) VALUES (?, ?, ?, ?, ?, ?, 'fixture:research.xml', ?, 0)
  `);
  function field(catalog, objectId, fieldPath, value) {
    const finalSegment = fieldPath.split(".").at(-1) ?? fieldPath;
    insertField.run(
      catalog,
      objectId,
      fieldPath,
      String(value),
      finalSegment.replace(/^@/, "").replace(/\[.*$/, "") || "Value",
      finalSegment.startsWith("@") ? finalSegment.slice(1) : null,
      objectId,
    );
  }

  // AbilityCommand commandIndex is zero-based, whereas the Catalog research
  // slots are named Research1, Research2, ... . Research0 is deliberately a
  // foreign sentinel so an off-by-one resolver produces an observable leak.
  field("Abil", "FixtureResearch", "InfoArray[Research0].@Upgrade", "SlotZeroUpgrade");
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research0].Button.@DefaultButtonFace",
    "SlotZeroResearchButton",
  );
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research0].Button.@Requirements",
    "HaveSlotZeroResearch",
  );
  field("Abil", "FixtureResearch", "InfoArray[Research0].Button.@State", "Restricted");

  field("Abil", "FixtureResearch", "InfoArray[Research1].@Upgrade", "OwnResearchUpgrade");
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research1].Button.@DefaultButtonFace",
    "OwnResearchButton",
  );
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research1].Button.@Requirements",
    "HaveOwnResearch",
  );
  field("Abil", "FixtureResearch", "InfoArray[Research1].Button.@State", "Restricted");
  field("Abil", "FixtureResearch", "InfoArray[Research1].@Time", 45);
  field("Abil", "FixtureResearch", "InfoArray[Research1].Resource[Minerals]", 100);
  field("Abil", "FixtureResearch", "InfoArray[Research1].Resource[Vespene]", 75);

  // This is a normal-looking entry on the same shared research ability, but
  // it has direct ownership evidence for another commander only.
  field("Abil", "FixtureResearch", "InfoArray[Research2].@Upgrade", "ForeignSharedUpgrade");
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research2].Button.@DefaultButtonFace",
    "ForeignResearchButton",
  );
  field(
    "Abil",
    "FixtureResearch",
    "InfoArray[Research2].Button.@Requirements",
    "HaveForeignResearch",
  );
  field("Abil", "FixtureResearch", "InfoArray[Research2].Button.@State", "Available");

  field("Unit", "UnitAlpha", "AbilArray[#5].@Link", "RestrictedBlast");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#4].@Type", "Passive");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#4].@AbilCmd", "255");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#4].@Face", "OwnResearchPassive");
  field(
    "Unit",
    "UnitAlpha",
    "CardLayouts[#0].LayoutButtons[#4].@Requirements",
    "HaveOwnResearch",
  );
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#5].@Type", "Passive");
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#5].@AbilCmd", "255");
  field(
    "Unit",
    "UnitAlpha",
    "CardLayouts[#0].LayoutButtons[#5].@Face",
    "ForeignResearchPassive",
  );
  field(
    "Unit",
    "UnitAlpha",
    "CardLayouts[#0].LayoutButtons[#5].@Requirements",
    "HaveForeignResearch",
  );
  field("Unit", "UnitAlpha", "CardLayouts[#0].LayoutButtons[#6].@Type", "AbilCmd");
  field(
    "Unit",
    "UnitAlpha",
    "CardLayouts[#0].LayoutButtons[#6].@AbilCmd",
    "RestrictedBlast,Execute",
  );
  field(
    "Unit",
    "UnitAlpha",
    "CardLayouts[#0].LayoutButtons[#6].@Face",
    "RestrictedBlastButton",
  );
  field("Abil", "RestrictedBlast", "CmdButtonArray[Execute].@State", "Restricted");

  field(
    "Upgrade",
    "UnlockRestrictedBlast",
    "EffectArray[#0].@Reference",
    "Abil,RestrictedBlast,CmdButtonArray[Execute].State",
  );
  field("Upgrade", "UnlockRestrictedBlast", "EffectArray[#0]", "Available");

  for (const [requirementId, nodeId, upgradeId] of [
    ["HaveSlotZeroResearch", "CountSlotZeroUpgrade", "SlotZeroUpgrade"],
    ["HaveOwnResearch", "CountOwnResearchUpgrade", "OwnResearchUpgrade"],
    ["HaveForeignResearch", "CountForeignResearchUpgrade", "ForeignSharedUpgrade"],
  ]) {
    field("Requirement", requirementId, "NodeArray[Use].@Link", nodeId);
    field("Requirement", nodeId, "Count.@Link", upgradeId);
  }

  const insertReference = database.prepare(`
    INSERT INTO object_references(
      source_catalog, source_object_id, field_path, target_catalog,
      target_object_id, confidence, evidence
    ) VALUES (?, ?, ?, ?, ?, 1.0, ?)
  `);
  function reference(sourceCatalog, sourceId, fieldPath, targetCatalog, targetId) {
    insertReference.run(
      sourceCatalog,
      sourceId,
      fieldPath,
      targetCatalog,
      targetId,
      `fixture:${fieldPath}`,
    );
  }
  reference("Unit", "UnitAlpha", "AbilArray[#5].@Link", "Abil", "RestrictedBlast");
  reference(
    "Upgrade",
    "UnlockRestrictedBlast",
    "EffectArray[#0].@Reference",
    "Abil",
    "RestrictedBlast",
  );
  for (const [requirementId, nodeId, upgradeId] of [
    ["HaveSlotZeroResearch", "CountSlotZeroUpgrade", "SlotZeroUpgrade"],
    ["HaveOwnResearch", "CountOwnResearchUpgrade", "OwnResearchUpgrade"],
    ["HaveForeignResearch", "CountForeignResearchUpgrade", "ForeignSharedUpgrade"],
  ]) {
    reference("Requirement", requirementId, "NodeArray[Use].@Link", "Requirement", nodeId);
    reference("Requirement", nodeId, "Count.@Link", "Upgrade", upgradeId);
  }

  const insertText = database.prepare(`
    INSERT INTO localized_text(locale, text_key, value, source_file)
    VALUES ('zhcn', ?, ?, 'fixture:research-gamestrings.txt')
  `);
  for (const [key, value] of [
    ["Button/Name/SlotZeroResearchButton", "错误的零号研究"],
    ["Button/Name/OwnResearchButton", "正确的一号研究"],
    ["Button/Tooltip/OwnResearchButton", "由零基命令索引选择 Research1。"],
    ["Button/Name/OwnResearchPassive", "本指挥官研究被动"],
    ["Button/Name/ForeignResearchButton", "共享研究中的外来项目"],
    ["Button/Name/ForeignResearchPassive", "外来研究被动"],
    ["Button/Name/RestrictedBlastButton", "受限爆发"],
    ["Button/Tooltip/RestrictedBlastButton", "由指挥官升级精确解锁。"],
    ["Button/Name/FixtureResearchPackButton", "测试研究包"],
    ["Button/Name/RestrictedBlastPerkButton", "受限爆发强化"],
  ]) {
    insertText.run(key, value);
  }

  database.exec(`
    INSERT INTO commander_membership VALUES
      ('TerranFixture', 'Abil', 'FixtureResearch', 'typed-userdata:AbilityCommand', 0),
      ('TerranFixture', 'Abil', 'RestrictedBlast', 'reference-depth:1', 1),
      ('TerranFixture', 'Upgrade', 'OwnResearchUpgrade', 'reference-depth:2', 2),
      ('TerranFixture', 'Upgrade', 'ForeignSharedUpgrade', 'reference-depth:2', 2),
      ('TerranFixture', 'Upgrade', 'UnlockRestrictedBlast', 'typed-userdata:Upgrade', 0),
      ('TerranForeign', 'Upgrade', 'SlotZeroUpgrade', 'typed-userdata:Upgrade', 0),
      ('TerranForeign', 'Upgrade', 'ForeignSharedUpgrade', 'typed-userdata:Upgrade', 0),
      ('TerranForeign', 'Button', 'ForeignResearchButton', 'typed-userdata:Button', 0),
      ('TerranForeign', 'Button', 'ForeignResearchPassive', 'typed-userdata:Button', 0);
  `);

  const currentProfile = JSON.parse(database
    .prepare("SELECT profile_json FROM commander_profiles WHERE commander_id='TerranFixture'")
    .get().profile_json);
  currentProfile.levelPerks.push(
    {
      id: "FixtureResearchPack",
      level: 4,
      levelId: "FixtureLevel04",
      nameZhCN: "测试研究包",
      links: [
        {
          catalog: "Abil",
          objectId: "FixtureResearch",
          fieldId: "AbilityCommand",
          index: 0,
          commandIndex: 0,
        },
        {
          catalog: "Button",
          objectId: "FixtureResearchPackButton",
          fieldId: "Button",
          index: 0,
          commandIndex: null,
        },
      ],
    },
    {
      id: "RestrictedBlastPerk",
      level: 6,
      levelId: "FixtureLevel06",
      nameZhCN: "受限爆发强化",
      links: [
        {
          catalog: "Upgrade",
          objectId: "UnlockRestrictedBlast",
          fieldId: "Upgrade",
          index: 0,
          commandIndex: null,
        },
        {
          catalog: "Button",
          objectId: "RestrictedBlastPerkButton",
          fieldId: "Button",
          index: 0,
          commandIndex: null,
        },
      ],
    },
  );
  database.prepare(`
    UPDATE commander_profiles SET profile_json=? WHERE commander_id='TerranFixture'
  `).run(JSON.stringify(currentProfile));
}

function itemWithId(items, id) {
  return items.find((item) => item.ids.includes(id));
}

function factMap(item) {
  return Object.fromEntries((item?.facts ?? []).map((fact) => [fact.label, fact.value]));
}

function allItems(details) {
  return details.weapons.concat(details.skills, details.commanderUpgrades);
}

test("buildUnitDetails extracts weapons and visible skills for arbitrary units", () => {
  const database = createFixture();
  try {
    const alpha = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitAlpha",
    });
    const beta = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitBeta",
    });

    assert.ok(alpha);
    assert.ok(beta);
    assert.ok(itemWithId(alpha.weapons, "AlphaRifle"));
    assert.ok(itemWithId(beta.weapons, "BetaFlamer"));
    assert.ok(itemWithId(alpha.skills, "AlphaStim"));
    assert.ok(itemWithId(beta.skills, "BetaBurst"));
    assert.equal(itemWithId(alpha.skills, "AlphaHidden"), undefined);

    const exposedIds = allItems(alpha).flatMap((item) => item.ids).map((id) => id.toLowerCase());
    assert.equal(exposedIds.includes("move"), false);
    assert.equal(exposedIds.includes("stop"), false);
    assert.equal(exposedIds.includes("attack"), false);

    for (const item of allItems(alpha).concat(allItems(beta))) {
      assert.ok(item.ids.length > 0);
      assert.equal(typeof item.nameZhCN, "string");
      assert.ok(item.nameZhCN.length > 0);
      assert.equal(typeof item.descriptionZhCN, "string");
      for (const fact of item.facts ?? []) {
        assert.equal(typeof fact.label, "string");
        assert.equal(typeof fact.value, "string");
      }
    }
  } finally {
    database.close();
  }
});

test("buildUnitProjection keeps a real Unit ahead of a stale ArmyCategory mapping", () => {
  const database = createFixture();
  try {
    database.exec(`
      INSERT INTO catalog_objects(
        catalog, object_id, class, parent_id, is_default, source_file, direct_xml
      ) VALUES
        ('ArmyCategory', 'UnitAlpha', 'CArmyCategory', NULL, 0, 'fixture:army.xml', '<Object/>'),
        ('ArmyCategory', 'FallbackCategory', 'CArmyCategory', NULL, 0, 'fixture:army.xml', '<Object/>');

      INSERT INTO catalog_fields(
        catalog, object_id, path, value, field_tag, attribute,
        source_file, origin_object_id, inheritance_depth
      ) VALUES
        ('Unit', 'UnitAlpha', 'LifeMax', '200', 'LifeMax', NULL,
          'fixture:data.xml', 'UnitAlpha', 0),
        ('Unit', 'UnitBeta', 'LifeMax', '125', 'LifeMax', NULL,
          'fixture:data.xml', 'UnitBeta', 0),
        ('ArmyCategory', 'UnitAlpha', 'Unit', 'MissingLegacyUnit', 'Unit', NULL,
          'fixture:army.xml', 'UnitAlpha', 0),
        ('ArmyCategory', 'FallbackCategory', 'Unit', 'UnitBeta', 'Unit', NULL,
          'fixture:army.xml', 'FallbackCategory', 0);
    `);

    const direct = buildUnitProjection(database, {
      commanderId: "TerranFixture",
      unit: { techId: "UnitAlpha", unitId: "UnitAlpha" },
      includeDetails: false,
    });
    assert.equal(direct.stats.unitId, "UnitAlpha");
    assert.equal(direct.stats.lifeMax, 200);

    const fallback = buildUnitProjection(database, {
      commanderId: "TerranFixture",
      unit: { techId: "FallbackCategory", unitId: "FallbackCategory" },
      includeDetails: false,
    });
    assert.equal(fallback.stats.unitId, "UnitBeta");
    assert.equal(fallback.stats.lifeMax, 125);
  } finally {
    database.close();
  }
});

test("buildUnitDetails follows bounded Effect chains and honors weapon defaults and target filters", () => {
  const database = createFixture();
  try {
    const alpha = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitAlpha",
    });
    const beta = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitBeta",
    });
    const alphaFacts = factMap(itemWithId(alpha.weapons, "AlphaRifle"));
    const betaFacts = factMap(itemWithId(beta.weapons, "BetaFlamer"));

    assert.equal(alphaFacts["基础伤害"], "6");
    assert.equal(alphaFacts["攻击范围"], "5");
    assert.equal(alphaFacts["攻击前摇"], "0.17 秒");
    assert.equal(alphaFacts["可攻击目标"], "对地");
    assert.equal(alphaFacts["基础DPS"], "4");

    // BetaLaunch -> BetaSet -> BetaCycle -> BetaSet is cyclic. The builder
    // must still find BetaDamage once and terminate.
    assert.equal(betaFacts["基础伤害"], "12");
    assert.equal(betaFacts["攻击范围"], "7");
    assert.equal(betaFacts["攻击前摇"], "0.2 秒");
    assert.equal(betaFacts["可攻击目标"], "对空");
    assert.equal(betaFacts["基础DPS"], "6");

    for (const value of Object.values(alphaFacts).concat(Object.values(betaFacts))) {
      assert.equal(/(?:NaN|Infinity)/.test(value), false);
    }
  } finally {
    database.close();
  }
});

test("buildUnitDetails deduplicates cards, filters foreign Requirements, and is deterministic", () => {
  const database = createFixture();
  try {
    const first = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitAlpha",
    });
    const second = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitAlpha",
    });

    assert.deepEqual(second, first);
    assert.equal(first.skills.filter((item) => item.ids.includes("AlphaStim")).length, 1);

    const ownPassive = allItems(first).find((item) =>
      item.ids.includes("OwnPassiveButton") || item.nameZhCN === "本指挥官被动");
    assert.ok(ownPassive);

    const leakedForeignContent = allItems(first).some((item) =>
      item.ids.some((id) => /Foreign/i.test(id)) ||
      /外来协议|另一个指挥官/.test(`${item.nameZhCN} ${item.descriptionZhCN}`));
    assert.equal(leakedForeignContent, false);
  } finally {
    database.close();
  }
});

test("buildUnitDetails maps profile research slots and unlocks only directly modified restricted abilities", () => {
  const database = createFixture();
  try {
    addResearchRegressionFixture(database);
    const details = buildUnitDetails(database, {
      commanderId: "TerranFixture",
      unitId: "UnitAlpha",
    });

    const ownResearch = allItems(details).find((item) =>
      item.ids.includes("OwnResearchUpgrade"));
    assert.ok(ownResearch, "commandIndex 0 must resolve the Catalog's Research1 entry");
    assert.ok(ownResearch.ids.includes("FixtureResearch"));
    assert.ok(ownResearch.ids.includes("OwnResearchButton"));
    assert.deepEqual(factMap(ownResearch), {
      研究费用: "100 矿 / 75 气",
      研究时间: "45 秒",
    });

    const allIds = allItems(details).flatMap((item) => item.ids);
    assert.equal(
      allIds.includes("SlotZeroUpgrade"),
      false,
      "the zero-based profile command must never read a non-existent Research0 slot",
    );

    const restrictedBlast = itemWithId(details.skills, "RestrictedBlast");
    assert.ok(
      restrictedBlast,
      "a restricted active ability must be shown when a profile-direct Upgrade precisely modifies it",
    );
    assert.equal(restrictedBlast.nameZhCN, "受限爆发");

    assert.equal(
      allIds.includes("ForeignSharedUpgrade"),
      false,
      "an available entry on a shared research ability must not imply commander ownership",
    );
    assert.equal(
      allIds.includes("ForeignResearchPassive"),
      false,
      "a passive gated by another commander's research must not leak",
    );
  } finally {
    database.close();
  }
});
