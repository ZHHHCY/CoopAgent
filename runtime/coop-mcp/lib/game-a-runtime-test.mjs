import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const GAME_A_TEST_MAP_NAME = "CoopAgentTest.SC2Map";
export const GAME_A_TEST_CONFIG_NAME = "CoopAgentTest.SC2TestConfig";

const TEST_CONFIG =
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  "<TestConfig>\r\n" +
  '    <Attribute AttNamespace="0" Id="1" Player="1" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="2" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="3" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="4" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="1" Player="5" Value="0001"/>\r\n' +
  '    <Attribute AttNamespace="0" Id="2" Player="16" Value="0001"/>\r\n' +
  "</TestConfig>\r\n";

const LOG_SUFFIXES = ["ScriptError.txt", "Alerts.txt"];
const MAX_CORRELATED_LOGS = 12;

export class GameARuntimeTestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GameARuntimeTestError";
    this.details = details;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tailText(value, maxChars) {
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function launchDetached(executablePath, args, workingDirectory) {
  const child = spawn(executablePath, args, {
    cwd: workingDirectory,
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: false,
  });
  try {
    await once(child, "spawn");
  } catch (error) {
    throw new GameARuntimeTestError(`无法启动 SC2Switcher：${executablePath}`, {
      executablePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  child.unref();
  return { pid: child.pid ?? null, exitCode: () => child.exitCode };
}

async function runTasklist(imageName) {
  if (process.platform !== "win32") return new Set();
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "tasklist.exe");
  const child = spawn(executable, ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) {
    throw new GameARuntimeTestError("无法检查正在运行的 StarCraft II 进程。", {
      exitCode,
      stderr: stderr.slice(0, 1_000),
    });
  }
  return parseTasklistProcessIds(stdout, imageName);
}

export function parseTasklistProcessIds(output, imageName = "SC2_x64.exe") {
  const result = new Set();
  for (const line of output.split(/\r?\n/)) {
    const columns = [...line.matchAll(/"((?:[^"]|"")*)"/g)]
      .map((match) => (match[1] ?? "").replaceAll('""', '"'));
    if ((columns[0] ?? "").toLowerCase() !== imageName.toLowerCase()) continue;
    const pid = Number(columns[1]);
    if (Number.isSafeInteger(pid) && pid > 0) result.add(pid);
  }
  return result;
}

export function resolveRuntimePaths(sc2Root, namespace = null) {
  const root = path.resolve(sc2Root);
  const switcherCandidates = [
    path.join(root, "Support64", "SC2Switcher_x64.exe"),
    path.join(root, "Support", "SC2Switcher.exe"),
  ];
  const switcherPath = switcherCandidates.find((candidate) => existsSync(candidate));
  if (!switcherPath) {
    throw new GameARuntimeTestError("StarCraft II 安装中没有找到 SC2Switcher。", {
      sc2Root: root,
      checked: switcherCandidates,
    });
  }
  if (namespace && !/^[a-zA-Z0-9-]+$/.test(namespace)) throw new GameARuntimeTestError('Invalid runtime project namespace');
  const testRoot = path.join(root, "Maps", "Test", ...(namespace ? ['CoopAgent', namespace] : []));
  return {
    sc2Root: root,
    testRoot,
    stagedMapPath: path.join(testRoot, GAME_A_TEST_MAP_NAME),
    mapRelativePath: path.relative(path.join(root, 'Maps'), path.join(testRoot, GAME_A_TEST_MAP_NAME)).replaceAll('/', '\\'),
    configPath: path.join(testRoot, GAME_A_TEST_CONFIG_NAME),
    switcherPath,
    gameImageName: switcherPath.toLowerCase().includes("support64") ? "SC2_x64.exe" : "SC2.exe",
  };
}

export function buildRuntimeArguments(configPath, { displayMode = 1, mapRelativePath = path.win32.join("Test", GAME_A_TEST_MAP_NAME) } = {}) {
  return [
    "-run",
    mapRelativePath,
    "-displaymode",
    String(displayMode),
    "-preload",
    "1",
    "-NoUserCheats",
    "-reloadcheck",
    "-meleeMod",
    "Void",
    "-difficulty",
    "2",
    "-speed",
    "2",
    "-testconfig",
    configPath,
  ];
}

async function snapshotLogs(logsDirectory) {
  if (!existsSync(logsDirectory)) return [];
  const entries = await readdir(logsDirectory, { withFileTypes: true });
  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LOG_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    const filePath = path.join(logsDirectory, entry.name);
    const metadata = await stat(filePath);
    logs.push({ name: entry.name, size: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  return logs.sort((left, right) => left.name.localeCompare(right.name));
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function stageMap(paths, mapPath, runId) {
  const source = path.resolve(mapPath);
  const metadata = await stat(source).catch(() => null);
  if (!metadata?.isDirectory() || !source.toLowerCase().endsWith(".sc2map")) {
    throw new GameARuntimeTestError("自动测试需要一个未打包的 .SC2Map 目录。", { mapPath: source });
  }

  const expectedTarget = path.join(paths.testRoot, GAME_A_TEST_MAP_NAME);
  if (path.resolve(paths.stagedMapPath) !== path.resolve(expectedTarget)) {
    throw new GameARuntimeTestError("拒绝写入非固定的自动测试地图路径。", {
      target: paths.stagedMapPath,
    });
  }

  await mkdir(paths.testRoot, { recursive: true });
  const incoming = path.join(paths.testRoot, `${GAME_A_TEST_MAP_NAME}.incoming-${runId}`);
  if (!isInside(paths.testRoot, incoming) || path.dirname(incoming) !== path.resolve(paths.testRoot)) {
    throw new GameARuntimeTestError("自动测试暂存路径越过了 Maps\\Test。", { incoming });
  }

  await rm(incoming, { recursive: true, force: true });
  try {
    await cp(source, incoming, { recursive: true, errorOnExist: true });
    await rm(paths.stagedMapPath, { recursive: true, force: true });
    await rename(incoming, paths.stagedMapPath);
    await writeFile(paths.configPath, TEST_CONFIG, "utf8");
  } catch (error) {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw new GameARuntimeTestError("无法把 Game A 暂存到 StarCraft II\\Maps\\Test。", {
      source,
      target: paths.stagedMapPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseAlertDiagnostics(content) {
  const diagnostics = [];
  const ignored = /^(?:=+|StarCraft II \(|Executable\s|<|Parent Executable|Grandparent Executable|LocalTime\s)/;
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z]+)\s+\d+\s+\d+\.\d+\s+\d+\.\d+\s+(.*)$/.exec(line);
    if (!match) continue;
    const channel = match[1] ?? "USER";
    const message = (match[2] ?? "").trim();
    if (!message || ignored.test(message)) continue;
    const severity =
      channel === "ERROR" || channel === "FATAL" || /\b(?:error|failed|fatal|invalid)\b/i.test(message)
        ? "error"
        : channel === "WARNING" || /\bmissing\b/i.test(message)
          ? "warning"
          : "info";
    diagnostics.push({ severity, channel, message });
  }
  return diagnostics;
}

function isKnownOfflineWarning(message) {
  return (
    /(?:无权调用|not authorized|permission)/i.test(message) &&
    /(?:StatEvent|Achievement)/i.test(message) &&
    /(?:libCOOC|libCOMI)/i.test(message)
  );
}

export function parseScriptDiagnostics(content) {
  const diagnostics = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    const isCompileFailure = /^(?:Script compile error:|Script load failed:)|(?:无法找到Include文件|脚本读取失败|解析函数行出错)/i.test(line);
    const isTriggerFailure = /^(?:Trigger Error in )|出现触发器错误/.test(line);
    if (!isCompileFailure && !isTriggerFailure) continue;

    const next = (lines[index + 1] ?? "").trim();
    const message = next.startsWith("Near line ") ? `${line} ${next}` : line;
    if (next.startsWith("Near line ")) index += 1;
    if (seen.has(message)) continue;
    seen.add(message);
    diagnostics.push({
      severity: isKnownOfflineWarning(message) ? "warning" : "error",
      channel: "SCRIPT",
      code: isKnownOfflineWarning(message) ? "KNOWN_OFFLINE_PERMISSION" : "SCRIPT_FAILURE",
      message,
    });
  }
  return diagnostics;
}

export function parseRuntimeMetadata(content) {
  const version = /^<Version>\s+([^\r\n]+)\r?$/m.exec(content)?.[1]?.trim() ?? null;
  const dataBuild = /^<DataBuild>\s+([^\r\n]+)\r?$/m.exec(content)?.[1]?.trim() ?? null;
  return { version, dataBuild };
}

async function correlatedLogs(logsDirectory, run, maxChars) {
  const before = new Map(run.logsBefore.map((entry) => [entry.name, entry]));
  const current = await snapshotLogs(logsDirectory);
  const relevant = current
    .filter((entry) => {
      const previous = before.get(entry.name);
      return !previous || previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs;
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_CORRELATED_LOGS);

  const logs = [];
  const diagnostics = [];
  let runtimeMetadata = { version: null, dataBuild: null };
  for (const entry of relevant) {
    const filePath = path.join(logsDirectory, entry.name);
    const content = await readFile(filePath, "utf8");
    const parsed = entry.name.endsWith("ScriptError.txt")
      ? parseScriptDiagnostics(content)
      : parseAlertDiagnostics(content);
    const metadata = parseRuntimeMetadata(content);
    runtimeMetadata = {
      version: runtimeMetadata.version ?? metadata.version,
      dataBuild: runtimeMetadata.dataBuild ?? metadata.dataBuild,
    };
    diagnostics.push(...parsed.map((item) => ({ ...item, log: entry.name })));
    logs.push({
      name: entry.name,
      path: filePath,
      size: entry.size,
      modifiedAt: new Date(entry.mtimeMs).toISOString(),
      truncated: content.length > maxChars,
      tail: tailText(content, maxChars),
    });
  }
  if (
    run.expectedSc2Version &&
    runtimeMetadata.version &&
    run.expectedSc2Version !== runtimeMetadata.version
  ) {
    diagnostics.push({
      severity: "error",
      channel: "RUNTIME",
      code: "SC2_VERSION_MISMATCH",
      message: `Expected SC2 ${run.expectedSc2Version}, received ${runtimeMetadata.version}.`,
    });
  }
  if (
    run.expectedDataBuild &&
    runtimeMetadata.dataBuild &&
    run.expectedDataBuild !== runtimeMetadata.dataBuild
  ) {
    diagnostics.push({
      severity: "error",
      channel: "RUNTIME",
      code: "SC2_DATA_BUILD_MISMATCH",
      message: `Expected ${run.expectedDataBuild}, received ${runtimeMetadata.dataBuild}.`,
    });
  }
  return { logs, diagnostics, runtimeMetadata };
}

export function createGameARuntimeTestService(options = {}) {
  const sc2Root = path.resolve(options.sc2Root ?? "C:\\Program Files (x86)\\StarCraft II");
  const documentsDirectory = path.resolve(options.documentsDirectory ?? path.join(process.env.USERPROFILE ?? "", "Documents"));
  const defaultStateParent = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local");
  const stateRoot = path.resolve(options.stateRoot ?? path.join(defaultStateParent, "CoopAgent", "runtime-tests"));
  const dependencies = {
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? delay,
    launch: options.launch ?? launchDetached,
    listProcessIds: options.listProcessIds ?? runTasklist,
    isProcessRunning: options.isProcessRunning ?? processIsRunning,
  };
  const logsDirectory = path.join(documentsDirectory, "StarCraft II", "GameLogs");
  const runsRoot = path.join(stateRoot, "runs");
  const latestPath = path.join(stateRoot, "latest.json");

  function runPath(runId) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      throw new GameARuntimeTestError("无效的自动测试 runId。", { runId });
    }
    return path.join(runsRoot, `${runId}.json`);
  }

  async function saveRun(run) {
    const storedPath = runPath(run.id);
    await writeJsonAtomic(storedPath, run);
    await writeJsonAtomic(latestPath, { runId: run.id });
  }

  async function loadRun(runId) {
    let selected = runId;
    if (!selected) {
      if (!existsSync(latestPath)) return null;
      selected = JSON.parse(await readFile(latestPath, "utf8")).runId;
    }
    const storedPath = runPath(selected);
    if (!existsSync(storedPath)) return null;
    return JSON.parse(await readFile(storedPath, "utf8"));
  }

  async function status({ runId, maxChars = 20_000 } = {}) {
    const run = await loadRun(runId);
    if (!run) return { status: "not-run", run: null, verification: "not-run", logs: [], diagnostics: [] };

    if (run.processStatus === "running" && !dependencies.isProcessRunning(run.gamePid)) {
      run.processStatus = "exited";
      run.exitedAt = dependencies.now().toISOString();
      await saveRun(run);
    }

    const evidence = await correlatedLogs(logsDirectory, run, maxChars);
    if (run.processStatus === "launch-failed") {
      evidence.diagnostics.unshift({
        severity: "error",
        channel: "LAUNCHER",
        code: "RUNTIME_LAUNCH_FAILED",
        message: run.error ?? "The automated runtime test did not start.",
      });
    }
    const errorCount = evidence.diagnostics.filter((item) => item.severity === "error").length;
    const warningCount = evidence.diagnostics.filter((item) => item.severity === "warning").length;
    const verification = errorCount > 0
      ? "failed"
      : evidence.logs.length === 0
        ? (run.processStatus === "running" ? "pending" : "inconclusive")
        : run.processStatus === "running"
          ? "clean-so-far"
          : "log-clean";
    return {
      status: "ok",
      run: {
        id: run.id,
        hostId: run.hostId,
        startedAt: run.startedAt,
        exitedAt: run.exitedAt ?? null,
        processStatus: run.processStatus,
        launcherPid: run.launcherPid,
        gamePid: run.gamePid,
        error: run.error ?? null,
        sourceMapPath: run.sourceMapPath,
        stagedMapPath: run.stagedMapPath,
        buildHash: run.buildHash ?? null,
      },
      verification,
      summary: { errorCount, warningCount, logCount: evidence.logs.length },
      runtime: evidence.runtimeMetadata,
      logs: evidence.logs,
      diagnostics: evidence.diagnostics,
    };
  }

  async function start({
    hostId,
    mapPath,
    buildHash = null,
    expectedSc2Version = null,
    expectedDataBuild = null,
    startupTimeoutMs = 30_000,
    displayMode = 1,
  }) {
    const namespace = process.env.COOPAGENT_PROJECT_ID ? `${process.env.COOPAGENT_PROJECT_ID}-${buildHash ?? 'default'}` : null;
    const paths = resolveRuntimePaths(sc2Root, namespace);
    const existing = await loadRun();
    if (existing?.processStatus === "running" && dependencies.isProcessRunning(existing.gamePid)) {
      throw new GameARuntimeTestError(`自动测试 ${existing.id} 仍在运行。`, {
        runId: existing.id,
        gamePid: existing.gamePid,
      });
    }

    const beforePids = await dependencies.listProcessIds(paths.gameImageName);
    if (beforePids.size > 0) {
      throw new GameARuntimeTestError("StarCraft II 已在运行，无法可靠识别新的测试进程。", {
        processIds: [...beforePids],
      });
    }

    const runId = randomUUID();
    const startedAt = dependencies.now();
    const logsBefore = await snapshotLogs(logsDirectory);
    const args = buildRuntimeArguments(paths.configPath, { displayMode, mapRelativePath: paths.mapRelativePath });
    let run = {
      recordVersion: 1,
      id: runId,
      hostId,
      startedAt: startedAt.toISOString(),
      exitedAt: null,
      processStatus: "launching",
      launcherPid: null,
      gamePid: null,
      sourceMapPath: path.resolve(mapPath),
      stagedMapPath: paths.stagedMapPath,
      buildHash,
      expectedSc2Version,
      expectedDataBuild,
      configPath: paths.configPath,
      switcherPath: paths.switcherPath,
      arguments: args,
      logsBefore,
    };
    await saveRun(run);
    try {
      await stageMap(paths, mapPath, runId);
      const launcher = await dependencies.launch(paths.switcherPath, args, paths.sc2Root);
      run = { ...run, launcherPid: launcher.pid };
      await saveRun(run);
      const deadline = startedAt.getTime() + startupTimeoutMs;
      let gamePid = null;

      while (dependencies.now().getTime() <= deadline) {
        const current = await dependencies.listProcessIds(paths.gameImageName);
        const started = [...current].filter((pid) => !beforePids.has(pid));
        if (started.length === 1) {
          gamePid = started[0];
          break;
        }
        if (started.length > 1) {
          throw new GameARuntimeTestError("测试启动期间出现了多个 StarCraft II 进程。", {
            processIds: started,
          });
        }
        if (launcher.exitCode() !== null && launcher.exitCode() !== 0) {
          throw new GameARuntimeTestError(`SC2Switcher 已退出，代码 ${launcher.exitCode()}。`, {
            launcherPid: launcher.pid,
          });
        }
        await dependencies.sleep(250);
      }

      if (!gamePid) {
        throw new GameARuntimeTestError(`StarCraft II 未在 ${startupTimeoutMs}ms 内启动。`, {
          launcherPid: launcher.pid,
        });
      }

      run = { ...run, processStatus: "running", gamePid };
      await saveRun(run);
      return status({ runId });
    } catch (error) {
      run = {
        ...run,
        processStatus: "launch-failed",
        failedAt: dependencies.now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await saveRun(run).catch(() => {});
      throw error;
    }
  }

  return { start, status };
}
