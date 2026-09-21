import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GAME_A_TEST_MAP_NAME,
  buildRuntimeArguments,
  createGameARuntimeTestService,
  parseAlertDiagnostics,
  parseRuntimeMetadata,
  parseScriptDiagnostics,
  parseTasklistProcessIds,
} from "../lib/game-a-runtime-test.mjs";

test("builds the editor-compatible SC2Switcher invocation", () => {
  const args = buildRuntimeArguments("C:\\SC2\\Maps\\Test\\CoopAgentTest.SC2TestConfig");
  assert.deepEqual(args.slice(0, 4), ["-run", `Test\\${GAME_A_TEST_MAP_NAME}`, "-displaymode", "1"]);
  assert.ok(args.includes("-NoUserCheats"));
  assert.ok(args.includes("-reloadcheck"));
  assert.equal(args.at(-1), "C:\\SC2\\Maps\\Test\\CoopAgentTest.SC2TestConfig");
});

test("parses Windows process discovery and SC2 diagnostics conservatively", () => {
  const processes = parseTasklistProcessIds(
    '"SC2_x64.exe","4112","Console","1","1,000 K"\r\n"Other.exe","8","Console","1","10 K"\r\n',
  );
  assert.deepEqual([...processes], [4112]);

  const scriptDiagnostics = parseScriptDiagnostics([
    "Script compile error: unexpected token",
    "'libCOMI_Func'出现触发器错误：无权调用'StatEventCreate'",
    "   Near line 5152 in libCOOC_gf_CC_StatEventCreate() in LibCOOC.galaxy",
    "'GameA_Func'出现触发器错误：参数无效",
    "   Near line 20 in GameA_Test() in GameA.galaxy",
  ].join("\r\n"));
  assert.deepEqual(scriptDiagnostics.map((item) => item.severity), ["error", "warning", "error"]);
  assert.deepEqual(
    parseRuntimeMetadata("<Version>               5.0.15.97579\r\n<DataBuild>             B97579\r\n"),
    { version: "5.0.15.97579", dataBuild: "B97579" },
  );

  const alertDiagnostics = parseAlertDiagnostics(
    "USER                181   11.312   11.312 Cannot create actor with actor catalog entry X.\r\n" +
    "ERROR               181   11.312   11.312 failed to load map\r\n",
  );
  assert.deepEqual(alertDiagnostics.map((item) => item.severity), ["info", "error"]);
});

test("stages one Game A build, records its process, and correlates only its logs", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coopagent-runtime-test-"));
  const sc2Root = path.join(temporary, "StarCraft II");
  const switcher = path.join(sc2Root, "Support64", "SC2Switcher_x64.exe");
  const mapPath = path.join(temporary, "GameA-Test.SC2Map");
  const documentsDirectory = path.join(temporary, "Documents");
  const logsDirectory = path.join(documentsDirectory, "StarCraft II", "GameLogs");
  const stateRoot = path.join(temporary, "state");
  await mkdir(path.dirname(switcher), { recursive: true });
  await mkdir(mapPath, { recursive: true });
  await mkdir(logsDirectory, { recursive: true });
  await writeFile(switcher, "fixture", "utf8");
  await writeFile(path.join(mapPath, "ComponentList.SC2Components"), "<Components/>", "utf8");
  await writeFile(path.join(logsDirectory, "old ScriptError.txt"), "old error", "utf8");

  let processChecks = 0;
  let running = true;
  let launchCall = null;
  const service = createGameARuntimeTestService({
    sc2Root,
    documentsDirectory,
    stateRoot,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
    sleep: async () => {},
    listProcessIds: async () => {
      processChecks += 1;
      return processChecks === 1 ? new Set() : new Set([4321]);
    },
    isProcessRunning: () => running,
    launch: async (executablePath, args, workingDirectory) => {
      launchCall = { executablePath, args, workingDirectory };
      return { pid: 1234, exitCode: () => null };
    },
  });

  const started = await service.start({ hostId: "fixture", mapPath });
  assert.equal(started.run.processStatus, "running");
  assert.equal(started.run.gamePid, 4321);
  assert.equal(started.verification, "pending");
  assert.equal(launchCall.executablePath, switcher);
  assert.equal(launchCall.workingDirectory, sc2Root);
  assert.ok(launchCall.args.includes("-testconfig"));
  assert.equal(
    await readFile(path.join(sc2Root, "Maps", "Test", GAME_A_TEST_MAP_NAME, "ComponentList.SC2Components"), "utf8"),
    "<Components/>",
  );

  await writeFile(
    path.join(logsDirectory, "new ScriptError.txt"),
    "Script load failed: GameA generated script\r\n",
    "utf8",
  );
  running = false;
  const finished = await service.status({ runId: started.run.id });
  assert.equal(finished.run.processStatus, "exited");
  assert.equal(finished.verification, "failed");
  assert.equal(finished.logs.length, 1);
  assert.equal(finished.logs[0].name, "new ScriptError.txt");
  assert.equal(finished.summary.errorCount, 1);
});
