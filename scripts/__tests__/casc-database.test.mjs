import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { DOMParser } from '@xmldom/xmldom';
import { inspectCatalogEditValue } from '../lib/patch-plan-executor.mjs';
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildCascDatabase } from "../lib/casc-database-builder.mjs";

function write(root, relative, contents) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

test("builds catalog graph, commander projection and PatchPlan compatibility output", () => {
  const temporary = path.join(os.tmpdir(), `coopagent-database-test-${process.pid}-${Date.now()}`);
  const cascRoot = path.join(temporary, "casc", "BTEST");
  const files = path.join(cascRoot, "files");
  const mods = path.join(cascRoot, "files", "mods");
  const output = path.join(temporary, "database", "BTEST");
  try {
    write(cascRoot, "manifest.json", JSON.stringify({ source: { version: "test" } }));
    write(
      mods,
      "core.sc2mod/base.sc2data/gamedata/unitdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CUnit default="1"><LifeMax value="45"/></CUnit>
        <CUnit id="Marine"><LifeMax value="55"/></CUnit>
      </Catalog>`,
    );
    write(
      files,
      "campaigns/libertystory.sc2campaign/base.sc2data/gamedata/abildata.xml",
      `<?xml version="1.0"?><Catalog>
        <CAbilTrain id="BarracksTrain">
          <InfoArray index="Train5" Time="25"><Unit value="Medic"/></InfoArray>
          <InfoArray index="Train6" Time="30"><Unit value="Firebat"/></InfoArray>
        </CAbilTrain>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/commanderdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CCommander default="1"/>
        <CCommander id="Random"/>
        <CCommander id="Raynor">
          <UserReference value="PlayerCommanders;TerranRaynor"/>
          <UnitArray Unit="HyperionVoidCoop"/>
          <TalentTreeArray Level="1" Talent="CommanderRaynorLevel01"/>
          <PrestigeArray value="CommanderPrestigeRaynorBioHealth"/>
          <CommanderAbilArray Button="CommanderTraitRaynorHyperion"/>
        </CCommander>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/userdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CUser id="PlayerCommanders">
          <Instances Id="TerranRaynor">
            <Text Text="UserData/PlayerCommanders/TerranRaynor_Name"><Field Id="Name"/></Text>
            <GameLink GameLink="HyperionVoidCoop"><Field Id="HeroUnit"/></GameLink>
          </Instances>
        </CUser>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/unitdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CUnit id="HyperionVoidCoop"><AbilArray Link="VoidCoopSummonHyperion"/></CUnit>
        <CUnit id="RaynorCampaignOnly"/>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/abildata.xml",
      `<?xml version="1.0"?><Catalog>
        <CAbilEffectInstant id="VoidCoopSummonHyperion"><Effect value="SummonHyperionCreateUnit"/></CAbilEffectInstant>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/effectdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CEffectCreateUnit id="SummonHyperionCreateUnit"><SpawnUnit value="HyperionVoidCoop"/></CEffectCreateUnit>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/upgradedata.xml",
      `<?xml version="1.0"?><Catalog>
        <CUpgrade id="ShieldWall">
          <EffectArray Reference="Unit,Marine,LifeMax" Value="30"/>
        </CUpgrade>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/gamedata/requirementdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CRequirement id="LearnShieldWall"><NodeArray index="Show" Link="CountUpgradeShieldWall"/></CRequirement>
        <CRequirementCountUpgrade id="CountUpgradeShieldWall"><Count Link="ShieldWall" State="CompleteOnly"/></CRequirementCountUpgrade>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/zhcn.sc2data/localizeddata/gamestrings.txt",
      "UserData/PlayerCommanders/TerranRaynor_Name=雷诺\n",
    );
    write(
      mods,
      "starcoop/starcoop.sc2mod/base.sc2data/libcoop.galaxy",
      "void CoopRaynorInit () {\n}\nnative int TestOwner(unit u);\nconst int TestPlayer = 16;\n",
    );
    write(
      mods,
      "starcoop/commanders/arcturusmengsk.sc2mod/base.sc2data/gamedata/commanderdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CCommander id="Mengsk"><UserReference value="PlayerCommanders;TerranMengsk"/></CCommander>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/commanders/arcturusmengsk.sc2mod/base.sc2data/gamedata/userdata.xml",
      `<?xml version="1.0"?><Catalog>
        <CUser id="PlayerCommanders">
          <Instances Id="TerranMengsk">
            <Text Text="UserData/PlayerCommanders/TerranMengsk_Name"><Field Id="Name"/></Text>
          </Instances>
        </CUser>
      </Catalog>`,
    );
    write(
      mods,
      "starcoop/commanders/arcturusmengsk.sc2mod/zhcn.sc2data/localizeddata/gamestrings.txt",
      "UserData/PlayerCommanders/TerranMengsk_Name=蒙斯克\n",
    );

    const result = buildCascDatabase({ cascRoot, output });
    assert.equal(result.report.schemaVersion, 2);
    assert.equal(result.report.semantics.version, 6);
    assert.equal(result.report.warnings.length, 0);
    assert.equal(result.report.acceptance.passed, true);
    assert.equal(result.report.acceptance.raynorBarracksCampaignUnits, true);
    assert.equal(result.report.stats.unknownCatalogObjects, 0);
    assert.ok(existsSync(path.join(output, "merged", "GameData", "UnitData.xml")));

    const database = new DatabaseSync(path.join(output, "coop.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(database.prepare("SELECT value FROM coop_semantic_meta WHERE key='version'").get().value, '6');
      assert.deepEqual(
        { ...database.prepare("SELECT id, name_zhcn FROM commanders WHERE id='TerranRaynor'").get() },
        { id: "TerranRaynor", name_zhcn: "雷诺" },
      );
      assert.deepEqual(
        database.prepare("SELECT id, name_zhcn FROM commanders ORDER BY id").all().map((row) => ({ ...row })),
        [
          { id: "TerranMengsk", name_zhcn: "蒙斯克" },
          { id: "TerranRaynor", name_zhcn: "雷诺" },
        ],
      );
      assert.equal(
        database
          .prepare("SELECT value FROM catalog_fields WHERE catalog='Unit' AND object_id='HyperionVoidCoop' AND path='LifeMax'")
          .get().value,
        "45",
      );
      assert.equal(
        database
          .prepare("SELECT value FROM catalog_fields WHERE catalog='Abil' AND object_id='BarracksTrain' AND path='InfoArray[Train5].Unit'")
          .get().value,
        "Medic",
      );
      assert.deepEqual(
        {
          ...database
            .prepare(`
              SELECT target_catalog, target_object_id FROM object_references
              WHERE source_catalog='Unit' AND source_object_id='HyperionVoidCoop'
                AND target_catalog='Abil'
            `)
            .get(),
        },
        { target_catalog: "Abil", target_object_id: "VoidCoopSummonHyperion" },
      );
      assert.deepEqual(
        {
          ...database.prepare(`
            SELECT target_catalog, target_object_id, evidence FROM object_references
            WHERE source_catalog='Upgrade' AND source_object_id='ShieldWall'
              AND field_path='EffectArray[0].@Reference'
          `).get(),
        },
        {
          target_catalog: "Unit",
          target_object_id: "Marine",
          evidence: "data-reference:LifeMax",
        },
      );
      assert.deepEqual(
        database.prepare(`
          SELECT target_catalog, target_object_id FROM object_references
          WHERE source_catalog='Requirement' AND source_object_id IN ('LearnShieldWall','CountUpgradeShieldWall')
          ORDER BY source_object_id
        `).all().map((row) => ({ ...row })),
        [
          { target_catalog: "Upgrade", target_object_id: "ShieldWall" },
          { target_catalog: "Requirement", target_object_id: "CountUpgradeShieldWall" },
        ],
      );
      assert.ok(
        database
          .prepare(`
            SELECT 1 FROM commander_membership
            WHERE commander_id='TerranRaynor' AND catalog='Unit' AND object_id='HyperionVoidCoop'
          `)
          .get(),
      );
      const raynorProfile = JSON.parse(
        database
          .prepare("SELECT profile_json FROM commander_profiles WHERE commander_id='TerranRaynor'")
          .get().profile_json,
      );
      assert.equal(raynorProfile.roster.units[0].unitId, "HyperionVoidCoop");
      assert.equal(raynorProfile.roster.units[0].source, "Commander.UnitArray");
      assert.equal(raynorProfile.levelPerks[0].id, "CommanderRaynorLevel01");
      assert.equal(raynorProfile.prestiges[0].id, "CommanderPrestigeRaynorBioHealth");
      assert.equal(raynorProfile.panel.traits[0].buttonId, "CommanderTraitRaynorHyperion");
      assert.equal(
        database
          .prepare(`
            SELECT 1 FROM commander_membership
            WHERE commander_id='TerranRaynor' AND catalog='Unit' AND object_id='RaynorCampaignOnly'
          `)
          .get(),
        undefined,
      );
      assert.ok(database.prepare("SELECT 1 FROM galaxy_symbols WHERE name='CoopRaynorInit'").get());
      assert.equal(database.prepare("SELECT kind FROM galaxy_symbols WHERE name='TestOwner'").get().kind, "native");
      assert.equal(database.prepare("SELECT kind FROM galaxy_symbols WHERE name='TestPlayer'").get().kind, "constant");
      assert.equal(database.prepare("SELECT value FROM meta WHERE key='galaxySymbolVersion'").get().value, "2");
    } finally {
      database.close();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('co-op Upgrade projection preserves inherited slots, appends and per-field provenance across definitions', (t) => {
  const root = path.join(os.tmpdir(), `coopagent-upgrade-layout-${process.pid}-${Date.now()}`);
  let db;
  t.after(() => { db?.close(); rmSync(root, {recursive:true, force:true}); });
  const cascRoot = path.join(root, 'BTEST');
  write(cascRoot, 'manifest.json', JSON.stringify({source:{version:'test'}}));
  write(cascRoot, 'files/mods/swarmmulti.sc2mod/base.sc2data/gamedata/upgradedata.xml',
    '<Catalog><CUpgrade id="Parent"><EffectArray Reference="Unit,Marine,LifeMax" Value="999"/></CUpgrade></Catalog>');
  write(cascRoot, 'files/mods/void.sc2mod/base.sc2data/gamedata/upgradedata.xml', `<Catalog>
    <CUpgrade default="1"><EffectArray Reference="Unit,Marine,LifeMax" Value="2"/></CUpgrade>
    <CUpgrade id="Child" parent="Parent"><EffectArray index="1" Value="7"/>
      <EffectArray Reference="Unit,Marine,LifeMax" Value="11"/></CUpgrade>
    <CUpgrade id="Parent"><EffectArray Reference="Unit,Marine,LifeMax" Value="5"/></CUpgrade>
  </Catalog>`);
  write(cascRoot, 'files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata/upgradedata.xml', `<Catalog>
    <CUpgrade id="Child"><EffectArray Reference="Unit,Marine,LifeMax" Value="13"/>
      <EffectArray index="2" Operation="Set"/></CUpgrade>
    <CUpgrade id="Removed" parent="Child"><EffectArray index="1" removed="1"/>
      <EffectArray Reference="Unit,Marine,LifeMax" Value="17"/></CUpgrade>
  </Catalog>`);
  write(cascRoot, 'files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata/unitdata.xml', '<Catalog><CUnit id="Marine"><LifeMax value="45"/></CUnit></Catalog>');
  const {databaseFile, output, report} = buildCascDatabase({cascRoot,output:path.join(root,'database')});
  assert.equal(report.packages.includes('swarmmulti.sc2mod'),false);
  db = new DatabaseSync(databaseFile,{readOnly:true});
  assert.match(db.prepare("EXPLAIN QUERY PLAN SELECT value FROM localized_text WHERE lower(locale) IN ('zhcn','enus') AND text_key=?")
    .all('Unit/Name/Marine').map(r=>r.detail).join('\n'),/SEARCH localized_text USING INDEX localized_text_key/);
  const fields = new Map(db.prepare("SELECT * FROM catalog_fields WHERE catalog='Upgrade' AND object_id='Child'").all().map(r=>[r.path,r]));
  assert.deepEqual([0,1,2,3].map(i=>fields.get(`EffectArray[${i}]`).value),['2','7','11','13']);
  assert.equal(fields.get('EffectArray[1].@Reference').origin_object_id,'Parent');
  assert.equal(fields.get('EffectArray[1]').origin_object_id,'Child');
  assert.match(fields.get('EffectArray[2]').source_file,/^void\.sc2mod:/);
  assert.match(fields.get('EffectArray[2].@Operation').source_file,/^starcoop\.sc2mod:/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM object_references WHERE source_catalog='Upgrade' AND source_object_id='Child' AND target_object_id='Marine'").get().n,4);
  const document = new DOMParser().parseFromString(readFileSync(path.join(output,'merged/GameData/UpgradeData.xml'),'utf8'),'text/xml');
  const baseObject = Array.from(document.documentElement.childNodes).find(n=>n.getAttribute?.('id')==='Child');
  for(const [index,value] of [[1,'7'],[2,'11'],[3,'13']]) {
    const read = inspectCatalogEditValue({baseDocument:document,baseObject,catalogPath:`EffectArray[${index}].@Value`});
    assert.equal(read.value,value);
    assert.equal(read.exists,true);
  }
  const removed = new Map(db.prepare("SELECT path,value FROM catalog_fields WHERE catalog='Upgrade' AND object_id='Removed'").all().map(r=>[r.path,r.value]));
  assert.equal(removed.has('EffectArray[1]'),false);
  assert.equal(removed.get('EffectArray[2]'),'11');
  assert.equal(removed.get('EffectArray[4]'),'17');
});

test('invalid Upgrade inheritance fails atomically and preserves the installed output', (t) => {
  const root = path.join(os.tmpdir(), `coopagent-upgrade-cycle-${process.pid}-${Date.now()}`);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cascRoot = path.join(root,'BTEST'), output = path.join(root,'database');
  write(cascRoot,'manifest.json',JSON.stringify({source:{version:'test'}}));
  write(cascRoot,'files/mods/starcoop/starcoop.sc2mod/base.sc2data/gamedata/upgradedata.xml',
    '<Catalog><CUpgrade id="A" parent="B"/><CUpgrade id="B" parent="A"/></Catalog>');
  write(output,'previous.txt','previous database remains installed');
  assert.throws(()=>buildCascDatabase({cascRoot,output}),/Upgrade array inheritance cycle/);
  assert.equal(readFileSync(path.join(output,'previous.txt'),'utf8'),'previous database remains installed');
  assert.equal(existsSync(`${output}.building-${process.pid}`),false);
});
