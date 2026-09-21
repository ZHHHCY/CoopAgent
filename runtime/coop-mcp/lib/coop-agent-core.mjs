import { APP_ROOT, applicationRoot, workspaceRoot, projectEnvironment } from '../../../scripts/lib/project-context.mjs';
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validatePatchPlan } from "../../../scripts/lib/patch-plan-executor.mjs";
import { createPlanSubmissionService } from "../../../scripts/lib/plan-submission.mjs";
import { createAgentTaskStore, taskContextFromEnvironment } from "../../../scripts/lib/agent-task.mjs";
import { compactPreparationError } from "./phase-diagnostics.mjs";
import { createCoopSearch } from "./coop-search.mjs";
import { buildPrivateUnitDraft, extendPrivateUnitDraft, PrivateDraftError } from "./private-unit-draft.mjs";
import { createGameARuntimeTestService } from "./game-a-runtime-test.mjs";
import { attachPatchExecution } from "./patch-plan-review.mjs";
import { assertGameAReadable, readGameAConsistently, withGameALock } from "../../../scripts/lib/game-a-transaction.mjs";

export const DEFAULT_REPO_ROOT = workspaceRoot();

const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export class CoopToolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CoopToolError";
    this.details = details;
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveRepoPath(repoRoot, relativePath, options = {}) {
  const { purpose = "path", forbiddenRoots = [] } = options;
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new CoopToolError(`${purpose} must be a non-empty repository-relative path.`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new CoopToolError(`${purpose} must be relative to the CoopAgent repository.`);
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!isInside(resolvedRoot, resolved)) {
    throw new CoopToolError(`${purpose} escapes the CoopAgent repository.`);
  }
  for (const forbiddenRoot of forbiddenRoots) {
    const resolvedForbiddenRoot = path.resolve(resolvedRoot, forbiddenRoot);
    if (isInside(resolvedForbiddenRoot, resolved)) {
      throw new CoopToolError(`${purpose} cannot target ${forbiddenRoot.replaceAll("\\", "/")}.`);
    }
  }
  return resolved;
}

export async function sha256File(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function requireNewPlanAuthoringContract(plan) {
  if (plan?.formatVersion !== 2) return;
  if (!plan.scope || !plan.isolation) {
    throw new CoopToolError(
      "New PatchPlan v2 drafts must declare both scope and isolation. Historical plans remain readable, but Agent-authored plans cannot omit the blast-radius contract.",
    );
  }
  if (typeof plan.userSummary?.text !== "string" || plan.userSummary.text.trim().length === 0) {
    throw new CoopToolError(
      "New PatchPlan v2 drafts must include one concise userSummary.text describing the user-visible outcome. Historical plans remain readable through the separate summary index.",
    );
  }
}

function appendLimited(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_COMMAND_OUTPUT) {
    return next;
  }
  return next.slice(next.length - MAX_COMMAND_OUTPUT);
}

export function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new CoopToolError(`Failed to start ${command}: ${error.message}`, { command, args }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new CoopToolError(`Command timed out after ${timeoutMs} ms.`, { command, args, stdout, stderr }));
        return;
      }
      if (code !== 0) {
        reject(new CoopToolError(`Command failed with exit code ${code}.`, {
          command,
          args,
          code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        }));
        return;
      }
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readReceipts(patchesDirectory) {
  if (!existsSync(patchesDirectory)) {
    return [];
  }
  const names = (await readdir(patchesDirectory))
    .filter((name) => name.endsWith(".receipt.json"))
    .sort();
  const receipts = [];
  for (const name of names) {
    const receipt = await readJson(path.join(patchesDirectory, name));
    receipts.push({
      id: receipt.planId,
      formatVersion: receipt.planFormatVersion,
      planSha256: receipt.planSha256,
      appliedAt: receipt.appliedAt,
      operationCount: Array.isArray(receipt.operations) ? receipt.operations.length : 0,
      receiptPath: path.posix.join("game-a", "patches", name),
    });
  }
  return receipts;
}

function powershellExecutable() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  return "powershell.exe";
}

function normalizeHost(hostRegistry, hostId) {
  const selected = hostId || hostRegistry.defaultHost;
  const host = hostRegistry.hosts.find((candidate) => candidate.id === selected);
  if (!host) {
    throw new CoopToolError(`Unknown Game A host '${selected}'.`, {
      availableHosts: hostRegistry.hosts.map((candidate) => candidate.id),
    });
  }
  return host;
}

function parseJsonCommandOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new CoopToolError(`${label} returned invalid JSON: ${error.message}`, { stdout: output });
  }
}

function tailText(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(text.length - maxChars);
}

async function latestMatchingFile(directory, suffix) {
  if (!existsSync(directory)) {
    return null;
  }
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(suffix)) {
      continue;
    }
    const filePath = path.join(directory, name);
    const metadata = await stat(filePath);
    if (metadata.isFile()) {
      candidates.push({ filePath, metadata });
    }
  }
  candidates.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
  return candidates[0] ?? null;
}

export function createCoopAgentCore(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const taskContext = taskContextFromEnvironment();
  const tasks = createAgentTaskStore(repoRoot);
  const commandRunner = options.commandRunner ?? runCommand;
  const documentsDirectory = options.documentsDirectory ?? path.join(os.homedir(), "Documents");
  const localAppDataDirectory =
    options.localAppDataDirectory ??
    process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local")
      : path.join(os.homedir(), ".local", "share"));
  const gameARoot = path.join(repoRoot, "game-a");
  const patchExecutor = path.join(applicationRoot(repoRoot), "scripts", "patch-plan.mjs");
  const submissions = createPlanSubmissionService({ repoRoot,
    ...(options.runGameAValidation === false ? { runGameAValidation: false } : {}) });
  const sc2Root = path.resolve(
    options.sc2Root ??
    process.env.COOPAGENT_SC2_ROOT ??
    "C:\\Program Files (x86)\\StarCraft II",
  );
  const runtimeTestService = options.runtimeTestService ?? createGameARuntimeTestService({
    sc2Root,
    documentsDirectory,
    stateRoot: process.env.COOPAGENT_WORKSPACE_ROOT ? path.join(repoRoot, 'game-a/runtime/runtime-tests') : path.join(localAppDataDirectory, "CoopAgent", "runtime-tests"),
  });

  function catalogDatabaseForBuild(dataBuild) {
    const environmentPath = process.env.COOPAGENT_CATALOG_ROOT;
    if (environmentPath) return { path: path.resolve(environmentPath), source: "environment" };
    const localPath = path.join(
      localAppDataDirectory,
      "CoopAgent",
      "database",
      dataBuild,
      "merged",
      "GameData",
    );
    return { path: localPath, source: "local-database" };
  }

  async function projectStatus() {
    return withGameALock(repoRoot, async () => {
      assertGameAReadable(repoRoot);
      return projectStatusLocked();
    }, { readOnly: true });
  }

  async function projectStatusLocked() {
    const [baseline, hosts, coreManifest, receipts] = await Promise.all([
      readJson(path.join(gameARoot, "runtime-baseline.json")),
      readJson(path.join(gameARoot, "hosts.json")),
      readJson(path.join(gameARoot, "core", "GameA.SC2Mod", "GameA.Core.json")),
      readReceipts(path.join(gameARoot, "patches")),
    ]);
    const catalogDatabase = catalogDatabaseForBuild(baseline.sc2.dataBuild);
    const catalogRoot = catalogDatabase.path;
    const buildRoot = path.join(gameARoot, "build");
    const hostStatuses = await Promise.all(hosts.hosts.map(async (host) => {
      const latestPointerPath = path.join(buildRoot, "latest", `${host.id}.json`);
      let outputPath = path.join(buildRoot, host.outputName);
      let sourceHash = null;
      if (existsSync(latestPointerPath)) {
        const pointer = await readJson(latestPointerPath);
        if (pointer.hostId !== host.id || typeof pointer.output !== "string") {
          throw new CoopToolError(`Invalid latest Game A build pointer for host '${host.id}'.`);
        }
        const pointedOutput = path.resolve(buildRoot, pointer.output);
        if (!isInside(buildRoot, pointedOutput) || pointedOutput === path.resolve(buildRoot)) {
          throw new CoopToolError(`Latest Game A build pointer for host '${host.id}' escapes game-a/build.`);
        }
        outputPath = pointedOutput;
        sourceHash = pointer.sourceHash ?? null;
      }
      return {
        ...host,
        isDefault: host.id === hosts.defaultHost,
        sourceExists: existsSync(path.join(applicationRoot(repoRoot), "game-a", host.source)),
        latestBuild: path.relative(gameARoot, outputPath).replaceAll("\\", "/"),
        sourceHash,
        buildExists: existsSync(path.join(outputPath, "ComponentList.SC2Components")),
        buildStampExists: existsSync(path.join(outputPath, ".gamea-build-hash")),
      };
    }));

    return {
      status: "ok",
      agentCoreStage: "domain-tools",
      submissionJobs: submissions.status({ limit: 5 }).map((job) => ({ jobId: job.jobId,
        state: job.state, planId: job.prepared.planId, error: job.error?.message ?? null })),
      repository: repoRoot,
      prerequisites: {
        cascDatabase: {
          configured: Boolean(catalogRoot),
          exists: Boolean(catalogRoot && existsSync(catalogRoot)),
          path: catalogRoot,
          source: catalogDatabase.source,
          sqlitePath: path.join(path.dirname(path.dirname(catalogRoot)), "coop.sqlite"),
        },
      },
      runtime: {
        baselineStatus: baseline.status,
        runtimeContract: baseline.schemaVersion,
        sc2Version: baseline.sc2.version,
        sc2DataBuild: baseline.sc2.dataBuild,
        coreSource: baseline.architecture.coreSource,
        coreModules: coreManifest.galaxy.modules.length,
        hosts: hostStatuses,
      },
      patchPlans: {
        appliedCount: receipts.length,
        applied: receipts,
      },
    };
  }

  async function writePatchPlan({ plan, privateUnit, delivery } = {}) {
    if (taskContext) tasks.guard(taskContext);
    if (plan && privateUnit) throw new CoopToolError('Supply either plan or privateUnit, not both.');
    let expansion = null;
    if (privateUnit) {
      const baseline = await readJson(path.join(gameARoot, 'runtime-baseline.json'));
      const authoringSearch = options.authoringSearch ?? createCoopSearch({ repoRoot,
        localAppDataDirectory, ...(options.databaseFile ? { databaseFile: options.databaseFile } : {}) });
      try {
        expansion = authoringSearch.withProjectDatabase({ commanderId: privateUnit.commanderId }, () =>
          buildPrivateUnitDraft(privateUnit, { baseline, query: input => authoringSearch.execute(input) }));
      } catch (error) {
        if (error instanceof PrivateDraftError) throw new CoopToolError(error.message, error.details);
        throw error;
      }
      plan = expansion.plan;
    }
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      throw new CoopToolError("plan must be a PatchPlan JSON object.");
    }
    try {
      await validatePatchPlan(plan, path.join(applicationRoot(repoRoot), "docs", "schemas"));
    } catch (error) {
      throw new CoopToolError(error instanceof Error ? error.message : String(error), {
        errors: error?.details ?? [],
      });
    }
    requireNewPlanAuthoringContract(plan);

    const appliedPlan = path.join(gameARoot, "patches", `${plan.id}.patch-plan.json`);
    if (existsSync(appliedPlan)) {
      throw new CoopToolError(`PatchPlan '${plan.id}' has already been applied; use a new plan id.`);
    }

    const draftsRoot = path.join(gameARoot, "drafts");
    const target = path.join(draftsRoot, `${plan.id}.patch-plan.json`);
    const overwritten = existsSync(target);
    const schema = plan.formatVersion === 2
      ? "../../docs/schemas/patch-plan-v2.schema.json"
      : "../../docs/schemas/patch-plan.schema.json";
    let storedPlan = { ...plan, $schema: schema };
    let previousBytes = null;
    if (expansion && overwritten) {
      previousBytes = await readFile(target, 'utf8');
      try { storedPlan = extendPrivateUnitDraft(JSON.parse(previousBytes), storedPlan); }
      catch (error) { throw new CoopToolError(error.message, { ...error.details, planPath: path.relative(repoRoot, target).replaceAll('\\', '/') }); }
      await validatePatchPlan(storedPlan, path.join(applicationRoot(repoRoot), 'docs/schemas'));
      requireNewPlanAuthoringContract(storedPlan);
    }

    await mkdir(draftsRoot, { recursive: true });
    const bytes = `${JSON.stringify(storedPlan, null, 2)}\n`;
    const commit = () => {
      if (expansion && (existsSync(target) ? readFileSync(target, 'utf8') : null) !== previousBytes) {
        throw new CoopToolError('Draft changed while expanding; retry against the current draft.');
      }
      writeFileSync(target, bytes, 'utf8');
    };
    if (taskContext) tasks.draft({ ...taskContext, draftPath: path.relative(repoRoot, target).replaceAll("\\", "/"),
      plan: storedPlan, expansion, resolutions: delivery?.resolutions },
      commit);
    else commit();
    const result = {
      status: "written",
      planPath: path.relative(repoRoot, target).replaceAll("\\", "/"),
      overwritten,
      ...(expansion ? { draftOnly: true, plan: storedPlan, mapping: expansion.mapping,
        unresolved: expansion.unresolved, review: expansion.review, queryCount: expansion.queryCount } : {}),
    };
    if (expansion && taskContext) result.evidenceKey = tasks.observe({ ...taskContext,
      input: { operation: 'private_unit_draft', planId: plan.id }, output: result });
    if (taskContext) result.delivery = tasks.working(taskContext).delivery;
    return result;
  }

  async function runPatchPlan(planPath, { check, catalogRoot, approvedPlanSha256 } = {}) {
    const resolvedPlan = resolveRepoPath(repoRoot, planPath, {
      purpose: "PatchPlan path",
      forbiddenRoots: ["game-a/build"],
    });
    if (!resolvedPlan.endsWith(".json")) {
      throw new CoopToolError("PatchPlan path must name a JSON file.");
    }
    if (!existsSync(resolvedPlan)) {
      throw new CoopToolError(`PatchPlan does not exist: ${planPath}`);
    }

    const planBytes = await readFile(resolvedPlan);
    const plan = JSON.parse(planBytes.toString("utf8"));
    if (isInside(path.join(gameARoot, "drafts"), resolvedPlan)) {
      requireNewPlanAuthoringContract(plan);
    }
    const planSha256 = createHash("sha256").update(planBytes).digest("hex");
    if (!check) {
      if (!approvedPlanSha256 || approvedPlanSha256.toLowerCase() !== planSha256) {
        throw new CoopToolError("The approved PatchPlan SHA-256 does not match the current plan file.", {
          currentPlanSha256: planSha256,
        });
      }
    }

    if (!catalogRoot) {
      const baseline = await readJson(path.join(gameARoot, "runtime-baseline.json"));
      const discovered = catalogDatabaseForBuild(baseline.sc2.dataBuild).path;
      if (existsSync(discovered)) catalogRoot = discovered;
    }

    const args = [patchExecutor, resolvedPlan, "--expected-plan-sha256", planSha256];
    if (check) {
      args.push("--check");
    }
    if (catalogRoot) {
      const resolvedCatalogRoot = path.resolve(catalogRoot);
      if (!existsSync(resolvedCatalogRoot)) {
        throw new CoopToolError(`Catalog database root does not exist: ${resolvedCatalogRoot}`);
      }
      args.push("--catalog-root", resolvedCatalogRoot);
    }
    args.push("--json");

    let result;
    try {
      result = await commandRunner(process.execPath, args, { cwd: repoRoot, env: projectEnvironment(repoRoot), timeoutMs: 180_000 });
    } catch (error) {
      let failure;
      try { failure = JSON.parse(error.details?.stdout ?? "").error; } catch { /* retain process error */ }
      if (failure) throw new CoopToolError(failure.message, { ...failure, planSha256 });
      throw error;
    }
    const report = parseJsonCommandOutput(result.stdout, "PatchPlan executor");
    if (!report.review || report.planSha256 !== planSha256) {
      throw new CoopToolError("Executor did not return a validated result bound to these plan bytes.");
    }
    const review = attachPatchExecution(report.review, report.operations, {
      stage: check ? "static-checked" : "applied",
    });
    const reviewWarnings = review.diagnostics.map(
      (item) => `[${item.code}] ${item.message}`,
    );
    return {
      status: check ? "checked" : "applied",
      planPath: path.relative(repoRoot, resolvedPlan).replaceAll("\\", "/"),
      planSha256,
      report,
      review,
      warnings: [...(result.stderr ? [result.stderr] : []), ...reviewWarnings],
    };
  }

  async function preparePlan({ plan, catalogRoot, delivery } = {}) {
    const draft = await writePatchPlan({ plan, delivery });
    if (!catalogRoot) {
      const baseline = await readJson(path.join(gameARoot, "runtime-baseline.json"));
      const discovered = catalogDatabaseForBuild(baseline.sc2.dataBuild).path;
      if (existsSync(discovered)) catalogRoot = discovered;
    }
    // Bind the full requested object, not a second read of a mutable draft.
    try {
      const prepared = await submissions.prepare({ planContent: plan, planPath: draft.planPath,
        catalogRoot, runId: options.runId ?? process.env.COOPAGENT_RUN_ID ?? null, taskId: taskContext?.id ?? null });
      return { ...submissions.compact(prepared), ...(taskContext ? { delivery: tasks.working(taskContext).delivery } : {}) };
    } catch (error) {
      const diagnostic = compactPreparationError(error);
      if (taskContext) tasks.observe({ ...taskContext, input: { operation: "plan_prepare", planId: plan.id,
        planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex") }, output: diagnostic });
      if (error?.name === "PatchPlanError") throw new CoopToolError(error.message, diagnostic);
      throw error;
    }
  }

  async function submitPlan({ preparationId } = {}) {
    if (taskContext) tasks.guard(taskContext);
    const withDelivery = result => ({ ...result, ...(taskContext
      ? { delivery: tasks.get({ id: taskContext.id })?.selectedDelivery } : {}) });
    const selected = await submissions.submit({ preparationId,
      runId: options.runId ?? process.env.COOPAGENT_RUN_ID ?? null, selectOnly: true,
      selectCommit: taskContext ? (commit, record) => tasks.select({ ...taskContext, preparationId,
        plan: JSON.parse(record.planContent) }, commit) : undefined });
    if (selected.status === "applied") return withDelivery(submissions.compact(selected));
    const child = spawn(process.execPath, [path.join(APP_ROOT, "scripts/plan-submission.mjs"),
      "submit", preparationId, repoRoot], { cwd: repoRoot, windowsHide: true,
      detached: true, stdio: "ignore", env: projectEnvironment(repoRoot) });
    let spawnError = null;
    let exited = false;
    let exitCode = null;
    child.on("error", (error) => { spawnError = error; });
    child.on("exit", (code) => { exited = true; exitCode = code; });
    child.unref();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      let job = submissions.getJob(preparationId);
      if ((spawnError || exited) && ["submitted", "applying"].includes(job?.state)) {
        try {
          job = await submissions.workerFailed(preparationId,
            spawnError ? `提交进程无法启动：${spawnError.message}` : `提交进程已退出（${exitCode ?? "signal"}），任务尚未执行；可重试。`);
        } catch (error) { if (error.code !== "project-busy") throw error; }
      }
      if (job?.state === "applied") return withDelivery(submissions.compact(job.result));
      if (job && ["failed", "stale", "cancelled"].includes(job.state)) {
        throw new CoopToolError(job.error?.message ?? "Submission failed", { preparationId,
          jobId: preparationId, state: job.state, code: job.error?.code, review: job.error?.review });
      }
      if (spawnError) throw new CoopToolError(`Submission is saved but its worker could not start: ${spawnError.message}`,
        { preparationId, jobId: preparationId, state: "submitted" });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Observation timeout does not kill the committing worker or report failure.
    return withDelivery({ ...submissions.compact(selected), status: "submitted", message: "The backend is still processing this selected job; inspect project_status or retry this same preparationId." });
  }

  async function buildGameA({ hostId, checkOnly = false } = {}) {
    readGameAConsistently(repoRoot, () => null);
    const hostRegistry = await readJson(path.join(gameARoot, "hosts.json"));
    const host = normalizeHost(hostRegistry, hostId);
    const script = path.join(applicationRoot(repoRoot), "game-a/scripts", "build-game-a.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HostId", host.id];
    if (checkOnly) {
      args.push("-Check");
    }
    const result = await commandRunner(powershellExecutable(), args, { cwd: repoRoot, env: projectEnvironment(repoRoot), timeoutMs: 180_000 });
    const outputPath = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    return {
      status: checkOnly ? "build-checked" : "built",
      hostId: host.id,
      outputName: host.outputName,
      outputPath,
      output: result.stdout,
      warnings: result.stderr ? [result.stderr] : [],
    };
  }

  async function verifyRuntime({ hostId } = {}) {
    const hostRegistry = await readJson(path.join(gameARoot, "hosts.json"));
    const host = normalizeHost(hostRegistry, hostId);
    const script = path.join(applicationRoot(repoRoot), "game-a/scripts", "check-game-a-log.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-HostId", host.id];
    const result = await commandRunner(powershellExecutable(), args, { cwd: repoRoot, env: projectEnvironment(repoRoot), timeoutMs: 60_000 });
    return {
      status: "runtime-verified",
      hostId: host.id,
      output: result.stdout,
      warnings: result.stderr ? [result.stderr] : [],
    };
  }

  async function latestRuntimeLogs({ kind = "both", maxChars = 20_000 } = {}) {
    const logsDirectory = path.join(documentsDirectory, "StarCraft II", "GameLogs");
    const suffixes = kind === "both"
      ? ["ScriptError.txt", "Alerts.txt"]
      : [kind === "script-error" ? "ScriptError.txt" : "Alerts.txt"];
    const logs = [];
    for (const suffix of suffixes) {
      const latest = await latestMatchingFile(logsDirectory, suffix);
      if (!latest) {
        logs.push({ kind: suffix, found: false });
        continue;
      }
      const content = await readFile(latest.filePath, "utf8");
      logs.push({
        kind: suffix,
        found: true,
        path: latest.filePath,
        modifiedAt: latest.metadata.mtime.toISOString(),
        size: latest.metadata.size,
        truncated: content.length > maxChars,
        tail: tailText(content, maxChars),
      });
    }
    return { status: "ok", logsDirectory, logs };
  }

  async function startRuntimeTest({ hostId, startupTimeoutMs = 30_000 } = {}) {
    const [hostRegistry, baseline] = await Promise.all([
      readJson(path.join(gameARoot, "hosts.json")),
      readJson(path.join(gameARoot, "runtime-baseline.json")),
    ]);
    const host = normalizeHost(hostRegistry, hostId);
    const build = await buildGameA({ hostId: host.id });
    const componentPath = path.resolve(build.outputPath);
    const buildRoot = path.resolve(gameARoot, "build");
    if (
      path.basename(componentPath).toLowerCase() !== "componentlist.sc2components" ||
      !isInside(buildRoot, componentPath) ||
      !existsSync(componentPath)
    ) {
      throw new CoopToolError("Game A builder did not return a valid generated component list.", {
        hostId: host.id,
        outputPath: build.outputPath,
      });
    }
    const mapPath = path.dirname(componentPath);
    const buildStampPath = path.join(mapPath, ".gamea-build-hash");
    const buildHash = existsSync(buildStampPath)
      ? (await readFile(buildStampPath, "utf8")).trim()
      : null;
    const runtime = await runtimeTestService.start({
      hostId: host.id,
      mapPath,
      buildHash,
      expectedSc2Version: baseline.sc2.version,
      expectedDataBuild: baseline.sc2.dataBuild,
      startupTimeoutMs,
      displayMode: 1,
    });
    return { ...runtime, build };
  }

  async function runtimeTestStatus({ runId, maxChars = 20_000 } = {}) {
    return runtimeTestService.status({ runId, maxChars });
  }

  return {
    projectStatus,
    writePatchPlan,
    preparePlan,
    submitPlan,
    checkPatchPlan: (input) => runPatchPlan(input.planPath, { ...input, check: true }),
    applyPatchPlan: (input) => runPatchPlan(input.planPath, { ...input, check: false }),
    buildGameA,
    verifyRuntime,
    latestRuntimeLogs,
    startRuntimeTest,
    runtimeTestStatus,
  };
}
