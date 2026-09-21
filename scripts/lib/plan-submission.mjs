import { applicationRoot, projectIdentity } from './project-context.mjs';
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { executePatchPlanLocked, treeHash, PatchPlanError } from "./patch-plan-executor.mjs";
import { assertGameAReadable, recoverGameATransactionLocked, withGameALock } from "./game-a-transaction.mjs";
import { attachPatchExecution } from "../../runtime/coop-mcp/lib/patch-plan-review.mjs";
import { createAgentTaskStore } from './agent-task.mjs';
import { validatePrestigeContract } from './prestige-contract.mjs';
import { deriveRequestBinding, validateRequestBinding } from './request-binding.mjs';

const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const optional = async (file) => readFile(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const fileHash = async (file) => { const bytes = await optional(file); return bytes === null ? null : hash(bytes); };
const databasePath = (repo) => path.join(repo, "game-a/runtime/plan-jobs.sqlite");
const timestamp = () => new Date().toISOString();
const validId = (id) => /^prep-[a-f0-9]{48}$/.test(id);

async function directoryHash(root, accept = () => true) {
  if (!existsSync(root)) return null;
  const rows = [];
  async function visit(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Cannot bind linked project input: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && accept(name)) rows.push([name, await fileHash(path.join(root, name))]);
    }
  }
  await visit("");
  return hash(stable(rows));
}

export async function capturePreparationContext({ repoRoot, catalogRoot, databaseFile }) {
  return {
    version: 1,
    projectId: projectIdentity(repoRoot),
    core: await treeHash(path.join(repoRoot, "game-a/core/GameA.SC2Mod")),
    appliedPlans: await directoryHash(path.join(repoRoot, "game-a/patches"), (name) => name.endsWith(".json")),
    baseline: await fileHash(path.join(repoRoot, "game-a/runtime-baseline.json")),
    database: databaseFile ? await fileHash(databaseFile) : null,
    mergedCatalog: catalogRoot ? await directoryHash(catalogRoot) : null,
    executor: hash(stable(await Promise.all([
      directoryHash(path.join(implementationRoot, "scripts/lib"), (name) => name.endsWith(".mjs")),
      directoryHash(path.join(implementationRoot, "runtime/coop-mcp/lib"), (name) => name.endsWith(".mjs")),
      directoryHash(path.join(applicationRoot(repoRoot), "docs/schemas"), (name) => name.endsWith(".json")),
      directoryHash(path.join(applicationRoot(repoRoot), "game-a/scripts"), (name) => name.endsWith(".ps1")),
    ]))),
  };
}

function openStore(repoRoot) {
  mkdirSync(path.dirname(databasePath(repoRoot)), { recursive: true });
  const db = new DatabaseSync(databasePath(repoRoot), { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS preparations (
      id TEXT PRIMARY KEY, record TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      preparation_id TEXT PRIMARY KEY REFERENCES preparations(id), run_id TEXT,
      state TEXT NOT NULL, result TEXT, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cancelled_runs (run_id TEXT PRIMARY KEY, cancelled_at TEXT NOT NULL);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_selection_per_run ON jobs(run_id)
    WHERE run_id IS NOT NULL AND state IN ('submitted','applying','applied')`);
  return db;
}

export class PlanSubmissionError extends PatchPlanError {
  constructor(message, code, details = {}) { super(message); this.code = code; this.submissionDetails = details; }
}

/** Prepared snapshots and explicit selections live on the backend, never in a
 * frontend event/trace inference. All project writes use the same project lock. */
export function createPlanSubmissionService({ repoRoot, runGameAValidation = true, transactionHooks } = {}) {
  repoRoot = path.resolve(repoRoot);
  const store = (callback) => { const db = openStore(repoRoot); try { return callback(db); } finally { db.close(); } };
  const load = (id) => store((db) => {
    if (!validId(id)) throw new PlanSubmissionError("Invalid preparationId", "invalid-preparation");
    const row = db.prepare("SELECT record FROM preparations WHERE id=?").get(id);
    if (!row) throw new PlanSubmissionError("Unknown preparationId; prepare the plan first", "unknown-preparation");
    const record = JSON.parse(row.record);
    if (record.projectId != null && record.projectId !== projectIdentity(repoRoot)) throw new PlanSubmissionError('Preparation belongs to another project', 'wrong-project');
    return record;
  });
  const cancelled = (runId) => runId && store((db) => Boolean(db.prepare("SELECT 1 FROM cancelled_runs WHERE run_id=?").get(runId)));
  const assertNotCancelled = (runId) => {
    if (cancelled(runId)) throw new PlanSubmissionError("This Agent run was cancelled before submission", "run-cancelled");
  };
  const job = (id) => store((db) => db.prepare("SELECT * FROM jobs WHERE preparation_id=?").get(id));
  function setJob(id, runId, state, result = null, error = null) {
    store((db) => db.prepare(`INSERT INTO jobs VALUES (?,?,?,?,?,?) ON CONFLICT(preparation_id) DO UPDATE SET
      state=excluded.state,result=excluded.result,error=excluded.error,updated_at=excluded.updated_at`)
      .run(id, runId ?? null, state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : null, timestamp()));
  }
  function resultFor(record, report, applied = false) {
    const review = attachPatchExecution(report.review, report.operations, { stage: applied ? "applied" : "static-checked" });
    return { status: applied ? "applied" : "prepared", preparationId: record.id,
      jobId: applied ? record.id : null, planId: report.id, planPath: record.planPath,
      planSha256: record.planSha256, runId: record.runId, report, review, runtimeVerified: false };
  }
  function compact(result) {
    // The model needs a token and actionable evidence, not the binding hashes.
    return { status: result.status, preparationId: result.preparationId, jobId: result.jobId,
      planId: result.planId, summary: result.review.userSummary,
      operationCount: result.report.operations.length, changedFiles: result.report.changedFiles,
      receiptPath: result.status === "applied" ? result.report.receiptRecord : null,
      warnings: result.review.diagnostics.filter((item) => item.severity !== "error")
        .map(({ code, message }) => ({ code, message })), runtimeVerified: false };
  }
  async function prepare({ planContent, planPath, catalogRoot = null, databaseFile = null, runId = null, taskId = null }) {
    const content = typeof planContent === "string" ? planContent : JSON.stringify(planContent);
    const plan = JSON.parse(content);
    databaseFile ??= catalogRoot ? path.join(path.dirname(path.dirname(catalogRoot)), "coop.sqlite") : null;
    return withGameALock(repoRoot, async () => {
      assertGameAReadable(repoRoot);
      assertNotCancelled(runId);
      const contextOptions = { repoRoot, catalogRoot, databaseFile };
      const context = await capturePreparationContext(contextOptions);
      const taskStore = taskId ? createAgentTaskStore(repoRoot) : null;
      const task = taskStore?.get({ id: taskId }) ?? null;
      if (task) {
        const binding = deriveRequestBinding({ databaseFile, messages: (task.turns ?? []).map(turn => ({
          turnId: turn.id, text: turn.input })).concat((task.clarifications ?? []).map(item => ({
          turnId: task.turnId, text: item.answer }))) });
        taskStore.recordRequestBinding({ id: taskId, binding });
        try { validateRequestBinding(plan, binding, { databaseFile, evidence: taskStore.bindingEvidence({ id: taskId }) }); }
        catch (error) { throw new PlanSubmissionError(error.message, 'request-binding-mismatch', { binding }); }
      }
      validatePrestigeContract(plan, { databaseFile, request: task?.prompt ?? '',
        requestReplies: [...(task?.turns ?? []).slice(1).map(item => item.input),
          ...(task?.clarifications ?? []).map(item => item.answer)] });
      const report = await executePatchPlanLocked({ repoRoot, planPath, planContent: content,
        catalogRoot, databaseFile, check: true, runGameAValidation });
      if (stable(context) !== stable(await capturePreparationContext(contextOptions))) {
        throw new PlanSubmissionError("Project inputs changed during preparation; prepare again", "preparation-stale");
      }
      assertNotCancelled(runId);
      const planSha256 = hash(content);
      const id = `prep-${hash(stable({ planSha256, context, artifacts: report.receipt.coreTreeAfterSha256, runId, taskId })).slice(0, 48)}`;
      const record = { id, projectId: projectIdentity(repoRoot), sessionId: task?.modelSessionId ?? null, planPath, planContent: content, planSha256, runId, taskId, catalogRoot, databaseFile, context, report,
        priorReceiptHash: await fileHash(path.join(repoRoot, report.receiptRecord)) };
      store((db) => db.prepare("INSERT OR IGNORE INTO preparations VALUES (?,?,?)").run(id, JSON.stringify(record), timestamp()));
      return resultFor(record, report);
    });
  }
  async function submit({ preparationId, runId = null, retryOnly = false, selectOnly = false, selectCommit } = {}) {
    // Persist selection before execution. If the process disappears, recover()
    // resumes only these selected jobs, never mere successful preparations.
    const record = load(preparationId);
    if (runId && record.runId && runId !== record.runId) throw new PlanSubmissionError("Preparation belongs to another run", "wrong-run");
    const previous = job(preparationId);
    if (previous?.state === "applied") return JSON.parse(previous.result);
    if (retryOnly && !previous) throw new PlanSubmissionError("This preparation has not been selected by the Agent", "not-submitted");
    if (!previous) assertNotCancelled(record.runId);
    const select = selectCommit ?? ((commit, prepared) => {
      if (!prepared.taskId) return commit();
      const tasks = createAgentTaskStore(repoRoot); const task = tasks.get({ id: prepared.taskId });
      return tasks.select({ id: task.id, runId: prepared.runId, phase: task.phase, preparationId,
        plan: JSON.parse(prepared.planContent) }, commit);
    });
    if (!previous) select(() => store((db) => {
      db.prepare("INSERT OR IGNORE INTO jobs VALUES (?,?, 'submitted',NULL,NULL,?)")
        .run(preparationId, record.runId ?? null, timestamp());
      if (!db.prepare("SELECT 1 FROM jobs WHERE preparation_id=?").get(preparationId)) {
        throw new PlanSubmissionError("This run already selected another plan; continue edits in a new request", "run-already-submitted");
      }
    }), record);
    if (selectOnly) {
      if (["stale", "cancelled"].includes(previous?.state)) {
        const error = previous.error ? JSON.parse(previous.error) : {};
        throw new PlanSubmissionError(error.message ?? "Prepare a new plan before submitting", error.code ?? previous.state,
          { preparationId, jobId: preparationId, state: previous.state });
      }
      // Explicit retry must leave the old terminal state before a worker is
      // scheduled; otherwise the MCP observer immediately reads the old error.
      if (previous?.state === "failed") {
        assertNotCancelled(record.runId);
        try {
          store((db) => db.prepare("UPDATE jobs SET state='submitted',error=NULL,updated_at=? WHERE preparation_id=? AND state='failed'")
            .run(timestamp(), preparationId));
        } catch (error) {
          if (!String(error.message).includes("UNIQUE constraint")) throw error;
          throw new PlanSubmissionError("This run already selected another plan", "run-already-submitted");
        }
      }
      const selected = job(preparationId);
      if (selected?.state === "applied") return JSON.parse(selected.result);
      return { ...resultFor(record, record.report), status: "submitted", jobId: preparationId };
    }
    return withGameALock(repoRoot, async () => {
      const current = job(preparationId);
      if (current?.state === "applied") return JSON.parse(current.result);
      try {
        await recoverGameATransactionLocked(repoRoot);
        // Close the crash window between a committed receipt and job status.
        const receiptBytes = await optional(path.join(repoRoot, record.report.receiptRecord));
        const receipt = receiptBytes && JSON.parse(receiptBytes.toString("utf8"));
        if (receipt?.planSha256 === record.report.receipt.planSha256 &&
          (receipt.preparationId === preparationId || (record.report.changedFiles.length === 0 && hash(receiptBytes) === record.priorReceiptHash))) {
          const result = resultFor(record, { ...record.report, mode: "apply", receipt }, true);
          setJob(preparationId, record.runId, "applied", result);
          return result;
        }
        assertNotCancelled(record.runId);
        const contextOptions = { repoRoot, catalogRoot: record.catalogRoot, databaseFile: record.databaseFile };
        if (stable(record.context) !== stable(await capturePreparationContext(contextOptions))) {
          throw new PlanSubmissionError("Prepared project/data/executor state changed; prepare the plan again", "preparation-stale");
        }
        setJob(preparationId, record.runId, "applying");
        const report = await executePatchPlanLocked({ repoRoot, planPath: record.planPath,
          planContent: record.planContent, expectedPlanSha256: record.planSha256,
          expectedCoreTreeAfterSha256: record.report.receipt.coreTreeAfterSha256,
          provenance: { projectId: record.projectId, taskId: record.taskId, runId: record.runId, sessionId: record.sessionId },
          preparationId, catalogRoot: record.catalogRoot, databaseFile: record.databaseFile,
          runGameAValidation, transactionHooks,
          beforeCommit: async () => {
            assertNotCancelled(record.runId);
            if (stable(record.context) !== stable(await capturePreparationContext(contextOptions))) {
              throw new PlanSubmissionError("Project inputs changed before commit; prepare again", "preparation-stale");
            }
          },
        });
        const result = resultFor(record, report, true);
        setJob(preparationId, record.runId, "applied", result);
        return result;
      } catch (error) {
        const state = error.code === "run-cancelled" ? "cancelled" : error.code === "preparation-stale" ? "stale" : "failed";
        const details = { message: error.message, code: error.code ?? "apply-failed", review: error.review ?? null };
        setJob(preparationId, record.runId, state, null, details);
        throw new PlanSubmissionError(error.message, details.code, { preparationId, jobId: preparationId, state, review: error.review ?? null });
      }
    });
  }
  const rowResult = (row) => ({
    preparationId: row.preparation_id, jobId: row.preparation_id, runId: row.run_id, state: row.state,
    updatedAt: row.updated_at, result: row.result ? JSON.parse(row.result) : null,
    error: row.error ? JSON.parse(row.error) : null,
    prepared: resultFor(JSON.parse(row.record), JSON.parse(row.record).report),
  });
  function getJob(preparationId) {
    if (!validId(preparationId) || !existsSync(databasePath(repoRoot))) return null;
    const row = store((db) => db.prepare("SELECT j.*,p.record FROM jobs j JOIN preparations p ON p.id=j.preparation_id WHERE j.preparation_id=?")
      .get(preparationId));
    return row ? rowResult(row) : null;
  }
  async function workerFailed(preparationId, message) {
    // A child that could not start/exit before application must not leave a
    // permanently busy UI. Never overwrite a competing live commit or a receipt.
    return withGameALock(repoRoot, async () => {
      const current = job(preparationId);
      if (["submitted", "applying"].includes(current?.state)) {
        try {
          await recoverGameATransactionLocked(repoRoot);
          const record = load(preparationId);
          const bytes = await optional(path.join(repoRoot, record.report.receiptRecord));
          const receipt = bytes && JSON.parse(bytes.toString("utf8"));
          if (receipt?.preparationId === preparationId && receipt.planSha256 === record.report.receipt.planSha256) {
            setJob(preparationId, current.run_id, "applied", resultFor(record, { ...record.report, mode: "apply", receipt }, true));
            return getJob(preparationId);
          }
          setJob(preparationId, current.run_id, "failed", null, { code: "worker-failed", message });
        } catch (error) {
          setJob(preparationId, current.run_id, "failed", null, { code: "recovery-required", message: error.message });
        }
      }
      return getJob(preparationId);
    });
  }
  function status({ limit = 20 } = {}) {
    if (!existsSync(databasePath(repoRoot))) return [];
    return store((db) => db.prepare(`SELECT j.*,p.record FROM jobs j JOIN preparations p ON p.id=j.preparation_id
      WHERE j.state IN ('submitted','applying') OR j.preparation_id IN
        (SELECT preparation_id FROM jobs ORDER BY updated_at DESC LIMIT ?)
      ORDER BY j.updated_at DESC`).all(Math.min(100, Math.max(1, limit))).map(rowResult));
  }
  async function recover() {
    if (!existsSync(databasePath(repoRoot))) return [];
    const pending = store((db) => db.prepare("SELECT preparation_id AS preparationId FROM jobs WHERE state IN ('submitted','applying') ORDER BY updated_at").all());
    for (const row of pending) {
      try { await submit({ preparationId: row.preparationId, retryOnly: true }); }
      catch (error) { if (error.code === "project-busy") throw error; /* durable failure is inspectable */ }
    }
    return status();
  }
  function cancelRun(runId) {
    if (!runId) throw new PlanSubmissionError("runId is required", "invalid-run");
    store((db) => db.prepare("INSERT OR IGNORE INTO cancelled_runs VALUES (?,?)").run(runId, timestamp()));
    return { status: "cancel-requested", runId };
  }
  return { prepare, submit, status, getJob, workerFailed, recover, cancelRun, compact };
}
