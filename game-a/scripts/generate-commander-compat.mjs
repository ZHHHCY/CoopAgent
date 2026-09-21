#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// These are official B97579 files read from the user's local co-op database.
// Only this transformer and the hashes ship with Game A; transformed Blizzard
// sources exist exclusively inside ignored, rebuildable map output.
const REVISION = "game-a-commander-compat-v2";
const SOURCES = Object.freeze([
  {
    sourceFile: "starcoop.sc2mod:base.sc2data/libcooc.galaxy",
    output: "LibCOOC.galaxy",
    sha256: "2cfb852870ee83d29518af56a83502cb768b276a1063ba9d1c6e12a9170e1f48",
    playerCommanderCalls: 6,
  },
  {
    sourceFile: "starcoop.sc2mod:base.sc2data/libcooc_h.galaxy",
    output: "LibCOOC_h.galaxy",
    sha256: "d156b09ed1a663234ffafdb0d1813060a58606e24e3f59644299eadcbc0bfcd6",
    playerCommanderCalls: 0,
  },
  {
    sourceFile: "starcoop.sc2mod:base.sc2data/libcomi.galaxy",
    output: "LibCOMI.galaxy",
    sha256: "2c44f6ebe02fce3000914134523940acca5d8ed8282004cf297559cc6e11ad2b",
    playerCommanderCalls: 58,
  },
  {
    sourceFile: "starcoop.sc2mod:base.sc2data/libcoui.galaxy",
    output: "LibCOUI.galaxy",
    sha256: "4f5ad662972367bf53b2161f1012c7e833b466b55122da3fbe7b6c99f93decc1",
    playerCommanderCalls: 11,
  },
]);

const hash = (value) => createHash("sha256").update(value).digest("hex");
const count = (value, needle) => value.split(needle).length - 1;

function fail(message) {
  throw new Error(`Game A commander compatibility: ${message}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["fingerprint", "generate"]).has(command)) {
    fail("usage: generate-commander-compat.mjs fingerprint|generate [--baseline file] [--database file] [--output map]");
  }
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!new Set(["--baseline", "--database", "--output"]).has(name) || !value) fail(`invalid argument ${name ?? "<missing>"}`);
    options[name.slice(2)] = path.resolve(value);
  }
  if (command === "generate" && !options.output) fail("generate requires --output");
  return options;
}

function defaultDatabase(build) {
  const localData = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ??
    (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));
  return path.join(localData, "CoopAgent", "database", build, "coop.sqlite");
}

function loadSources(options) {
  const baselinePath = options.baseline ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime-baseline.json");
  if (!existsSync(baselinePath)) fail(`runtime baseline is missing: ${baselinePath}`);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const build = baseline.sc2?.dataBuild;
  if (build !== "B97579") fail(`reviewed transformer expects B97579, baseline is ${build ?? "missing"}`);
  const databaseFile = options.database ?? defaultDatabase(build);
  if (!existsSync(databaseFile)) fail(`local co-op database is missing: ${databaseFile}`);

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const actualBuild = database.prepare("SELECT value FROM meta WHERE key='sc2Build'").get()?.value;
    if (actualBuild !== build) fail(`database build ${actualBuild ?? "missing"} does not match runtime baseline ${build}`);
    const select = database.prepare("SELECT package_id, sha256, contents FROM galaxy_files WHERE source_file=?");
    return SOURCES.map((spec) => {
      const row = select.get(spec.sourceFile);
      if (!row) fail(`database does not contain ${spec.sourceFile}`);
      const actualHash = hash(row.contents);
      if (row.package_id !== "starcoop.sc2mod" || row.sha256 !== spec.sha256 || actualHash !== spec.sha256) {
        fail(`source drift for ${spec.sourceFile}; rebuild/review compatibility before launching Game A`);
      }
      if (count(row.contents, "PlayerCommander(") !== spec.playerCommanderCalls) {
        fail(`unexpected PlayerCommander call count in ${spec.sourceFile}`);
      }
      return { ...spec, contents: row.contents };
    });
  } finally {
    database.close();
  }
}

function replaceExactly(source, needle, replacement, expected, label) {
  const actual = count(source, needle);
  if (actual !== expected) fail(`${label} expected ${expected} exact match(es), found ${actual}`);
  return source.split(needle).join(replacement);
}

const wrapperDeclaration = "string libCOOC_gf_GameACommanderData (int lp_player);";
const wrapperFunction = `
// Game A local editor runs cannot assign paid commanders to the engine's
// PlayerCommander slot. Official co-op script consumers use the committed
// script identity instead; non-Game-A/online behavior remains native.
string libCOOC_gf_GameACommanderData (int lp_player) {
    string lv_commander;

    if ((GameIsOnline() == false) && (GameIsTestMap(false) == true)) {
        lv_commander = libCOOC_gf_ActiveCommanderForPlayer(lp_player);
        if ((lv_commander != null) && (lv_commander != "")) {
            return libCOOC_gf_CC_CommanderData(lv_commander);
        }
    }

    return PlayerCommander(lp_player);
}
`;

function transformHeader(source) {
  return replaceExactly(
    source,
    "string libCOOC_gf_ActiveCommanderForPlayer (int lp_player);",
    `string libCOOC_gf_ActiveCommanderForPlayer (int lp_player);\n${wrapperDeclaration}`,
    1,
    "LibCOOC_h declaration anchor",
  );
}

function transformCore(source) {
  source = replaceExactly(source, "PlayerCommander(", "libCOOC_gf_GameACommanderData(", 6, "LibCOOC identity reads");
  const commanderData = /string libCOOC_gf_CC_CommanderData \(string lp_commander\) \{\r?\n(?:.|\r|\n)*?\r?\n\}/;
  const match = source.match(commanderData);
  if (!match) fail("cannot locate CC_CommanderData implementation");
  source = replaceExactly(source, match[0], match[0] + "\n" + wrapperFunction, 1, "CC_CommanderData implementation");

  const nativeWrite = `    if ((libCOOC_gf_GameACommanderData(lp_player) != libCOOC_gf_CC_CommanderData(lp_commander))) {
        PlayerSetCommander(lp_player, libCOOC_gf_CC_CommanderData(lp_commander));
    }`;
  const guardedWrite = `    // The editor permits native identity writes only for the three free commanders.
    // Other local commanders are represented by COOP's script state and the wrapper above.
    if (((GameIsOnline() == true) || (GameIsTestMap(false) == false) ||
         (lp_commander == "TerranRaynor") || (lp_commander == "ZergKerrigan") ||
         (lp_commander == "ProtossArtanis")) &&
        (PlayerCommander(lp_player) != libCOOC_gf_CC_CommanderData(lp_commander))) {
        PlayerSetCommander(lp_player, libCOOC_gf_CC_CommanderData(lp_commander));
    }`;
  source = replaceExactly(source, nativeWrite, guardedWrite, 1, "CC_PlayerCommanderSet native write");

  for (const [player, commander] of [[1, "lv_commander1"], [2, "lv_commander2"]]) {
    const direct = `        PlayerSetCommander(${player}, UserDataGetGameLink("PlayerCommanders", ${commander}, "CommanderData", 1));\n`;
    source = replaceExactly(source, direct, "", 1, `contest-local player ${player} duplicate native write`);
  }
  return source;
}

function transformConsumer(source, spec) {
  source = replaceExactly(
    source,
    "PlayerCommander(",
    "libCOOC_gf_GameACommanderData(",
    spec.playerCommanderCalls,
    `${spec.output} identity reads`,
  );
  if (spec.output === "LibCOMI.galaxy") {
    const name = "void libCOMI_gf_VoicePackCommanderDefaultApply (int lp_player) {";
    const start = source.indexOf(name);
    const end = source.indexOf("\n}", start) + 2;
    if (start < 0 || end < start || count(source, name) !== 1) fail("cannot uniquely locate default voice-pack initialization");
    const original = source.slice(start, end);
    const guarded = replaceExactly(original,
      "    PlayerAddReward(lp_player, (lv_defaultvoicepack));",
      `    // Local editor tests cannot grant profile rewards. Preserve existing voice
    // selection and let startup continue; online/non-test reward behavior is unchanged.
    if ((GameIsOnline() == true) || (GameIsTestMap(false) == false)) {
        PlayerAddReward(lp_player, (lv_defaultvoicepack));
    }`,
      1, "default voice-pack reward grant");
    source = source.slice(0, start) + guarded + source.slice(end);
  }
  return source;
}

export function transformCommanderCompatibilityScript(entry) {
  // Galaxy accepts LF, and one normalized newline form makes exact guarded
  // replacements independent of how CASC materialized the text on Windows.
  const source = entry.contents.replace(/\r\n/g, "\n");
  if (entry.output === "LibCOOC_h.galaxy") return transformHeader(source);
  if (entry.output === "LibCOOC.galaxy") return transformCore(source);
  return transformConsumer(source, entry);
}

function fingerprint(entries) {
  const payload = [REVISION, ...entries.map(({ sourceFile, sha256 }) => `${sourceFile}:${sha256}`)].join("\n");
  return hash(payload);
}

export function runCommanderCompatibilityGenerator(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const entries = loadSources(options);
  const compatibilityHash = fingerprint(entries);
  if (options.command === "fingerprint") {
    process.stdout.write(`${compatibilityHash}\n`);
    return;
  }
  const baseData = path.join(options.output, "Base.SC2Data");
  mkdirSync(baseData, { recursive: true });
  const generated = [];
  for (const entry of entries) {
    const contents = transformCommanderCompatibilityScript(entry);
    const destination = path.join(baseData, entry.output);
    writeFileSync(destination, contents, "utf8");
    generated.push({ sourceFile: entry.sourceFile, sourceSha256: entry.sha256, output: `Base.SC2Data/${entry.output}`, outputSha256: hash(contents) });
  }
  const manifest = {
    schemaVersion: 1,
    revision: REVISION,
    compatibilityHash,
    purpose: "Route co-op identity reads through local commander state and skip unsupported default voice reward grants in local editor tests.",
    generated,
  };
  writeFileSync(path.join(options.output, ".gamea-commander-compat.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${compatibilityHash}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCommanderCompatibilityGenerator();
}
