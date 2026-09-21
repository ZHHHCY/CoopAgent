import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { resolveSc2DataReferences } from "../lib/sc2-data-reference.mjs";

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
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
  `);

  const insertObject = database.prepare(`
    INSERT OR IGNORE INTO catalog_objects(
      catalog, object_id, class, parent_id, is_default, source_file, direct_xml
    ) VALUES (?, ?, ?, NULL, 0, 'fixture:data.xml', '<Object/>')
  `);
  const insertField = database.prepare(`
    INSERT INTO catalog_fields(
      catalog, object_id, path, value, field_tag, attribute,
      source_file, origin_object_id, inheritance_depth
    ) VALUES (?, ?, ?, ?, ?, ?, 'fixture:data.xml', ?, 0)
  `);

  function field(catalog, objectId, path, value) {
    const finalSegment = path.split(".").at(-1) ?? path;
    insertObject.run(catalog, objectId, `C${catalog}`);
    insertField.run(
      catalog,
      objectId,
      path,
      String(value),
      finalSegment.replace(/^@/, "").replace(/\[.*$/, "") || "Value",
      finalSegment.startsWith("@") ? finalSegment.slice(1) : null,
      objectId,
    );
  }

  field("Effect", "SimpleDamage", "Amount", 50);
  field("Effect", "LifeLeechDamage", "Amount", 25);
  field("Effect", "PreciseDamage", "Amount", 1.236);
  field("Behavior", "SpeedBuff", "Modification.@MoveSpeedMultiplier", 1.23456);
  field("Behavior", "Afterburners", "Duration", 8);
  field("Behavior", "EnergyDrain", "Modification.@VitalRegenArray[2]", -1.5);
  field("Unit", "EnergyUser", "EnergyRegenRate", 0.5);
  field("Abil", "IndexedCost", "Cost[0].Cooldown.@TimeUse", 12.345);
  field("Upgrade", "RangeUpgrade", "EffectArray[0].@Reference", "Weapon,Artillery,Range");
  field("Upgrade", "RangeUpgrade", "EffectArray[0].@Operation", "Add");
  field("Upgrade", "RangeUpgrade", "EffectArray[0]", 3);

  return database;
}

test("resolveSc2DataReferences resolves a simple Catalog field", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '冲锋造成<d ref="Effect,SimpleDamage,Amount"/>点伤害。',
      ),
      "冲锋造成50点伤害。",
    );
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences evaluates arithmetic, parentheses, and unary negatives", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '移动速度提高<d ref="(Behavior,SpeedBuff,Modification.MoveSpeedMultiplier - 1) * 100" precision="2"/>%。',
      ),
      "移动速度提高23.46%。",
    );
    assert.equal(
      resolveSc2DataReferences(
        database,
        '每秒消耗<d ref="-1 * (Behavior,EnergyDrain,Modification.VitalRegenArray[2] + Unit,EnergyUser,EnergyRegenRate)"/>点能量。',
      ),
      "每秒消耗1点能量。",
    );
    assert.equal(
      resolveSc2DataReferences(
        database,
        '增幅：<d ref="Effect,SimpleDamage,Amount/Effect,LifeLeechDamage,Amount-1*100"/>%。',
      ),
      "增幅：100%。",
      "SC2 evaluates binary operators left-to-right unless parentheses override the order",
    );
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences resolves supported upgrade macros and time literals", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '射程提高<d ref="$UpgradeEffectArrayValue:RangeUpgrade:Weapon,Artillery,Range$"/>。',
      ),
      "射程提高3。",
    );
    assert.equal(resolveSc2DataReferences(database, '持续<d time="4"/>秒。'), "持续4秒。");
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences honors precision regardless of attribute order", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '伤害：<d precision="2" player="current" ref="Effect,PreciseDamage,Amount"/>。',
      ),
      "伤害：1.24。",
    );
    assert.equal(
      resolveSc2DataReferences(
        database,
        '冷却：<d player="current" ref="Abil,IndexedCost,Cost[0].Cooldown.TimeUse" precision="1"/>秒。',
      ),
      "冷却：12.3秒。",
    );
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences resolves every reference in one tooltip", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '造成<d ref="Effect,SimpleDamage,Amount"/>点伤害，吸收<d ref="Effect,LifeLeechDamage,Amount"/>点生命，持续<d ref="Behavior,Afterburners,Duration"/>秒。',
      ),
      "造成50点伤害，吸收25点生命，持续8秒。",
    );
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences treats omitted attribute markers as the effective field path", () => {
  const database = createFixture();
  try {
    assert.equal(
      resolveSc2DataReferences(
        database,
        '能量变化：<d ref="Behavior,EnergyDrain,Modification.VitalRegenArray[2]"/>。',
      ),
      "能量变化：-1.5。",
    );
    assert.equal(
      resolveSc2DataReferences(
        database,
        '冷却：<d ref="Abil,IndexedCost,Cost[0].Cooldown.TimeUse" precision="2"/>秒。',
      ),
      "冷却：12.35秒。",
    );
  } finally {
    database.close();
  }
});

test("resolveSc2DataReferences never deletes missing or unsupported values", () => {
  const database = createFixture();
  try {
    const resolved = resolveSc2DataReferences(
      database,
      '造成<d ref="Effect,MissingDamage,Amount"/>点伤害，提高<d ref="$BehaviorStackCount:BiomassBuff$*100"/>%，持续<d ref="Behavior,MissingBuff,Duration"/>秒。',
    );
    assert.equal(
      resolved,
      "造成未知数值点伤害，提高未知数值%，持续未知数值秒。",
    );
    assert.doesNotMatch(resolved, /造成\s*点|提高\s*%|持续\s*秒/);
  } finally {
    database.close();
  }
});
