import test from "node:test";
import assert from "node:assert/strict";
import { transformCommanderCompatibilityScript } from "../../game-a/scripts/generate-commander-compat.mjs";

const identityReads = Array.from({ length: 5 }, (_, index) =>
  `bool Read${index} () { return PlayerCommander(${index + 1}) != null; }`).join("\n");

const coreFixture = `
string libCOOC_gf_CC_CommanderData (string lp_commander) {
    return UserDataGetGameLink("PlayerCommanders", lp_commander, "CommanderData", 1);
}
void libCOOC_gf_CC_PlayerCommanderSet (int lp_player, string lp_commander) {
    if ((libCOOC_gv_cC_DevStart_Forced == false) && (GameMapIsBlizzard() == false) && (lp_commander != "TerranRaynor") && (lp_commander != "ZergKerrigan") && (lp_commander != "ProtossArtanis")) {
        libCOOC_gf_CC_PlayerCommanderSet(lp_player, "TerranRaynor");
        return ;
    }

    if ((PlayerCommander(lp_player) != libCOOC_gf_CC_CommanderData(lp_commander))) {
        PlayerSetCommander(lp_player, libCOOC_gf_CC_CommanderData(lp_commander));
    }

    libCOOC_gv_cCX_PlayerCommander[lp_player] = lp_commander;
}
void libCOOC_gf_CC_LoadDefaultCommanderForContestLocalTest () {
        PlayerSetCommander(1, UserDataGetGameLink("PlayerCommanders", lv_commander1, "CommanderData", 1));
        PlayerSetCommander(2, UserDataGetGameLink("PlayerCommanders", lv_commander2, "CommanderData", 1));
}
${identityReads}
`;

test("commander compatibility keeps one guarded native write and redirects official reads", () => {
  const transformed = transformCommanderCompatibilityScript({
    output: "LibCOOC.galaxy",
    contents: coreFixture,
    playerCommanderCalls: 6,
  });
  assert.match(transformed, /string libCOOC_gf_GameACommanderData/);
  assert.match(transformed, /lp_commander == "TerranRaynor"/);
  assert.equal(transformed.split("PlayerSetCommander(").length - 1, 1);
  assert.equal(transformed.split("PlayerCommander(").length - 1, 2);
  assert.equal(transformed.split("libCOOC_gf_GameACommanderData(").length - 1, 5);
});

test("header and consumer transforms are exact and fail closed on source drift", () => {
  const header = transformCommanderCompatibilityScript({
    output: "LibCOOC_h.galaxy",
    contents: "string libCOOC_gf_ActiveCommanderForPlayer (int lp_player);\r\n",
    playerCommanderCalls: 0,
  });
  assert.match(header, /GameACommanderData/);

  const consumer = transformCommanderCompatibilityScript({
    output: "LibCOUI.galaxy",
    contents: "PlayerCommander(1); PlayerCommander(2);",
    playerCommanderCalls: 2,
  });
  assert.doesNotMatch(consumer, /\bPlayerCommander\(/);
  assert.throws(() => transformCommanderCompatibilityScript({
    output: "LibCOUI.galaxy",
    contents: "PlayerCommander(1);",
    playerCommanderCalls: 2,
  }), /expected 2 exact match/);
});

const voiceFixture = `void libCOMI_gf_VoicePackCommanderDefaultApply (int lp_player) {
    string lv_defaultvoicepack;
    lv_defaultvoicepack = "test";
    PlayerAddReward(lp_player, (lv_defaultvoicepack));
}
void OtherReward () { PlayerAddReward(2, "other"); }
PlayerCommander(1);`;

test("only the default voice reward grant is guarded in local offline editor tests", () => {
  const result = transformCommanderCompatibilityScript({ output: "LibCOMI.galaxy", contents: voiceFixture.replace(/\n/g, "\r\n"), playerCommanderCalls: 1 });
  assert.match(result, /if \(\(GameIsOnline\(\) == true\) \|\| \(GameIsTestMap\(false\) == false\)\) \{\n        PlayerAddReward\(lp_player, \(lv_defaultvoicepack\)\);\n    \}/);
  assert.match(result, /void OtherReward \(\) \{ PlayerAddReward\(2, "other"\); \}/);
  assert.equal(result.split("PlayerAddReward(").length - 1, 2);
  assert.match(result, /libCOOC_gf_GameACommanderData\(1\)/);
  assert.equal(result, transformCommanderCompatibilityScript({ output: "LibCOMI.galaxy", contents: voiceFixture, playerCommanderCalls: 1 }));
});

test("voice reward transform fails closed on missing, duplicated or changed anchors", () => {
  for (const contents of ["PlayerCommander(1);", voiceFixture.replace('    PlayerAddReward(lp_player, (lv_defaultvoicepack));', ''), voiceFixture.replace('    PlayerAddReward(lp_player, (lv_defaultvoicepack));', '    PlayerAddReward(lp_player, (lv_defaultvoicepack));\n    PlayerAddReward(lp_player, (lv_defaultvoicepack));')]) {
    assert.throws(() => transformCommanderCompatibilityScript({ output: "LibCOMI.galaxy", contents, playerCommanderCalls: 1 }), /voice-pack/);
  }
});
