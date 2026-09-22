import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const digest = (data) => data === null ? null : createHash("sha256").update(data).digest("hex");
const transactionRoot = (repoRoot) => path.join(path.resolve(repoRoot), "game-a/runtime/patch-transaction");
const journalPath = (repoRoot) => path.join(transactionRoot(repoRoot), "journal.json");

export class GameATransactionError extends Error {
  constructor(message, code = "recovery-required") {
    super(message);
    this.name = "GameATransactionError";
    this.code = code;
  }
}

// An OS-backed SQLite lock is released even if the owner is killed. No PID-based
// stale lock stealing, polling, leases, or additional database dependency.
export function acquireGameALock(repoRoot, { readOnly = false } = {}) {
  const runtime = path.join(path.resolve(repoRoot), "game-a/runtime");
  mkdirSync(runtime, { recursive: true });
  const db = new DatabaseSync(path.join(runtime, "project-lock.sqlite"), { timeout: 0 });
  try {
    db.exec(readOnly ? "BEGIN" : "BEGIN EXCLUSIVE");
    if (readOnly) db.prepare("SELECT name FROM sqlite_master").all();
  } catch (error) {
    db.close();
    if (/locked|busy/i.test(error.message)) {
      throw new GameATransactionError("地图运行层正在预检、应用或构建，请等待当前操作完成后重试。", "project-busy");
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  };
}

export function assertGameAReadable(repoRoot) {
  const root = transactionRoot(repoRoot);
  if (!existsSync(root)) return;
  try {
    const journal = JSON.parse(readFileSync(journalPath(repoRoot), "utf8"));
    if (journal.version === 1 && ["committed", "rolled-back"].includes(journal.state)) return;
  } catch { /* Incomplete or damaged journals are never interpreted as success. */ }
  throw new GameATransactionError(
    `地图运行层有未完成的应用事务，已阻止读取/构建。请重试应用以先恢复，或运行 node scripts/game-a-transaction.mjs recover。恢复文件：${root}`,
  );
}

export function readGameAConsistently(repoRoot, read) {
  const release = acquireGameALock(repoRoot, { readOnly: true });
  try { assertGameAReadable(repoRoot); return read(); } finally { release(); }
}

export async function withGameALock(repoRoot, task, options) {
  const release = acquireGameALock(repoRoot, options);
  try { return await task(); } finally { release(); }
}

async function optionalBytes(file) {
  try { return await readFile(file); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function safeTarget(repoRoot, relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^game-a\/(?:core\/GameA\.SC2Mod\/.+|patches\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:patch-plan|receipt)\.json)$/.test(relative)) {
    throw new GameATransactionError(`Invalid transaction target: ${relative}`);
  }
  let current = path.resolve(repoRoot);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new GameATransactionError(`Refusing linked transaction target: ${relative}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
}

export async function renameWithRetry(source, target, {
  platform = process.platform, renameFile = rename,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // Windows indexers/readers can briefly deny replacement. Retry only the same
  // atomic rename, for at most 775 ms; never delete the destination to force it.
  for (let attempt = 0; ; attempt += 1) {
    try { await renameFile(source, target); return; }
    catch (error) {
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await sleep(25 * (2 ** attempt));
    }
  }
}

async function atomicWrite(file, bytes, token) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.coopagent-${token}.tmp`;
  const handle = await open(temporary, "w");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await renameWithRetry(temporary, file);
}

async function saveJournal(root, journal) {
  await atomicWrite(path.join(root, "journal.json"), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`), "journal");
}

function validateJournal(journal) {
  if (journal?.version !== 1 || !/^[a-f0-9-]{36}$/.test(journal.id) ||
      !["prepared", "applying", "recovery-required", "committed", "rolled-back"].includes(journal.state) ||
      !Array.isArray(journal.entries) || new Set(journal.entries.map((entry) => entry.target)).size !== journal.entries.length ||
      journal.entries.some((entry) => [entry.beforeHash, entry.afterHash].some((hash) => hash !== null && !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new GameATransactionError("地图运行层恢复记录损坏；已保留恢复文件，请勿继续写入工程。");
  }
}

async function savedBytes(root, index, side, hash) {
  if (hash === null) return null;
  const bytes = await readFile(path.join(root, `${index}.${side}`));
  if (digest(bytes) !== hash) throw new GameATransactionError(`地图运行层恢复文件校验失败：${index}.${side}`);
  return bytes;
}

async function install(target, bytes, token) {
  if (bytes === null) await rm(target, { force: true });
  else await atomicWrite(target, bytes, token);
  if (digest(await optionalBytes(target)) !== digest(bytes)) throw new GameATransactionError(`地图运行层写入后校验失败：${target}`);
}

async function rollback(repoRoot, journal, hooks = {}) {
  const root = transactionRoot(repoRoot);
  const failures = [];
  for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
    const entry = journal.entries[index];
    try {
      const target = await safeTarget(repoRoot, entry.target);
      const current = digest(await optionalBytes(target));
      if (current !== entry.beforeHash) {
        if (current !== entry.afterHash) throw new Error(`文件在事务外发生变化，拒绝覆盖：${entry.target}`);
        const before = await savedBytes(root, index, "before", entry.beforeHash);
        await hooks.beforeRollback?.(entry, index);
        await install(target, before, journal.id);
      }
      await rm(`${target}.coopagent-${journal.id}.tmp`, { force: true });
    } catch (error) { failures.push(`${entry.target}: ${error.message}`); }
  }
  if (failures.length) {
    journal.state = "recovery-required";
    journal.recoveryErrors = failures;
    let journalError = "";
    try { await saveJournal(root, journal); } catch (error) { journalError = `\n记录更新失败：${error.message}`; }
    throw new GameATransactionError(`地图运行层未能完整恢复，已保留备份并阻止后续操作。请重试恢复。恢复目录：${root}\n${failures.join("\n")}${journalError}`);
  }
  journal.state = "rolled-back";
  await saveJournal(root, journal);
  await rm(root, { recursive: true });
}

// Caller must hold the project lock. Recovery is repeatable, including when a
// prior recovery itself was interrupted. It never overwrites unrelated edits.
export async function recoverGameATransactionLocked(repoRoot) {
  const root = transactionRoot(repoRoot);
  if (!existsSync(root)) return { status: "clean" };
  const bytes = await optionalBytes(journalPath(repoRoot));
  if (bytes === null) {
    // No target is touched until the complete prepared journal is durable.
    await rm(root, { recursive: true });
    return { status: "discarded-preparation" };
  }
  let journal;
  try { journal = JSON.parse(bytes.toString("utf8")); validateJournal(journal); } catch (error) {
    throw new GameATransactionError(`地图运行层恢复记录不可读，恢复材料已保留：${root}\n${error.message}`);
  }
  // Validate targets even for completed journals before trusting their state.
  for (const entry of journal.entries) await safeTarget(repoRoot, entry.target);
  if (["committed", "rolled-back"].includes(journal.state)) {
    await rm(root, { recursive: true });
    return { status: journal.state, planId: journal.planId };
  }
  await rollback(repoRoot, journal);
  return { status: "rolled-back", planId: journal.planId };
}

export async function recoverGameATransaction(repoRoot) {
  return withGameALock(repoRoot, () => recoverGameATransactionLocked(repoRoot));
}

// Internal API; hooks are test-only fault injection, never PatchPlan input.
// Entries include core files AND the plan/receipt, so a receipt cannot survive a
// failed multi-file application. Caller holds the lock from reading the baseline.
export async function commitGameATransaction(repoRoot, { planId, entries, hooks = {} }) {
  const root = transactionRoot(repoRoot);
  if (existsSync(root)) throw new GameATransactionError("地图运行层已有未清理事务，必须先恢复。");
  await mkdir(root, { recursive: true });
  const journal = { version: 1, id: randomUUID(), planId, state: "prepared", entries: [] };
  let prepared = false;
  let committed = false;
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const target = await safeTarget(repoRoot, entry.target);
      const before = await optionalBytes(target);
      const after = entry.bytes;
      journal.entries.push({ target: entry.target, beforeHash: digest(before), afterHash: digest(after) });
      if (before !== null) await atomicWrite(path.join(root, `${index}.before`), before, journal.id);
      if (after !== null) await atomicWrite(path.join(root, `${index}.after`), after, journal.id);
    }
    validateJournal(journal);
    await saveJournal(root, journal);
    prepared = true;
    journal.state = "applying";
    await saveJournal(root, journal);
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const target = await safeTarget(repoRoot, entry.target);
      if (digest(await optionalBytes(target)) !== entry.beforeHash) throw new Error(`地图运行层文件在预备后发生变化：${entry.target}`);
      await hooks.beforeInstall?.(entry, index);
      await install(target, await savedBytes(root, index, "after", entry.afterHash), journal.id);
      await hooks.afterInstall?.(entry, index);
    }
    journal.state = "committed";
    await saveJournal(root, journal);
    committed = true;
  } catch (error) {
    if (prepared) {
      try { await rollback(repoRoot, journal, hooks); } catch (recoveryError) {
        throw new GameATransactionError(`${recoveryError.message}\n原始错误：${error.message}`);
      }
    } else {
      // Preparation never changes the core; if cleanup fails, a later recovery
      // can discard it. Do not mask the original error.
      try { await rm(root, { recursive: true }); } catch { /* persistent recovery directory */ }
    }
    throw error;
  }
  if (committed) {
    // A durable committed journal is the commit point. Cleanup failure cannot
    // turn a committed plan into a reported application failure.
    try { await rm(root, { recursive: true }); } catch { return { cleanupPending: true }; }
  }
  return { cleanupPending: false };
}
