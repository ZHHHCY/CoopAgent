import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createCoopAgentCore } from "../../runtime/coop-mcp/lib/coop-agent-core.mjs";
import { createCoopSearch } from "../../runtime/coop-mcp/lib/coop-search.mjs";
import {
  acquireGameALock, assertGameAReadable, commitGameATransaction,
  readGameAConsistently, recoverGameATransaction, renameWithRetry, withGameALock,
} from "../lib/game-a-transaction.mjs";

const targets = [
  "game-a/core/GameA.SC2Mod/first.xml",
  "game-a/core/GameA.SC2Mod/second.xml",
  "game-a/patches/example.patch-plan.json",
  "game-a/patches/example.receipt.json",
];
const entries = () => targets.map((target, index) => ({ target, bytes: Buffer.from(`after-${index}`) }));
const journalRoot = (root) => path.join(root, "game-a/runtime/patch-transaction");

test("atomic rename retries only bounded transient Windows errors without a delete fallback", async () => {
  let attempts = 0;
  const waits = [];
  await renameWithRetry("source", "target", { platform: "win32", sleep: async (ms) => waits.push(ms),
    renameFile: async (source, target) => { assert.equal(source, "source"); assert.equal(target, "target");
      if (++attempts < 3) throw Object.assign(new Error("busy"), { code: "EPERM" }); } });
  assert.deepEqual(waits, [25, 50]);
  assert.equal(attempts, 3);
  attempts = 0; waits.length = 0;
  await assert.rejects(renameWithRetry("source", "target", { platform: "win32", sleep: async (ms) => waits.push(ms),
    renameFile: async () => { attempts++; throw Object.assign(new Error("persistent"), { code: "EACCES" }); } }), { code: "EACCES" });
  assert.equal(attempts, 6); assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 775);
  for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"]]) {
    await assert.rejects(renameWithRetry("source", "target", { platform,
      sleep: () => { throw Error("must not retry"); }, renameFile: async () => { throw Object.assign(new Error(code), { code }); } }), { code });
  }
});

test("a short real Windows sharing lock releases before atomic replacement", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fixture(t);
  const script = '$s=[IO.File]::Open($env:COOP_TRANSACTION_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $s.Dispose()';
  const holder = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true,
    env: { ...process.env, COOP_TRANSACTION_LOCK: path.join(root, targets[0]) }, stdio: ["pipe", "pipe", "pipe"] });
  const done = once(holder, "exit");
  await once(holder.stdout, "data");
  const timer = setTimeout(() => holder.stdin.end("\n"), 150);
  try {
    await withGameALock(root, () => commitGameATransaction(root, { planId: "example", entries: entries() }));
    assert.equal(await readFile(path.join(root, targets[0]), "utf8"), "after-0");
    assert.equal(await readFile(path.join(root, targets[3]), "utf8"), "after-3");
  } finally { clearTimeout(timer); if (!holder.stdin.writableEnded) holder.stdin.end("\n"); await done; }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "coopagent-transaction-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(root, targets[0])), { recursive: true });
  for (const file of targets.slice(0, 2)) await writeFile(path.join(root, file), "original");
  return root;
}

async function assertRestored(root) {
  for (const file of targets.slice(0, 2)) assert.equal(await readFile(path.join(root, file), "utf8"), "original");
  for (const file of targets.slice(2)) assert.equal(existsSync(path.join(root, file)), false);
  assert.equal(existsSync(journalRoot(root)), false);
}

for (const [name, failIndex, after] of [["core write", 1, false], ["receipt write", 3, false], ["after receipt installation", 3, true]]) {
  test(`rolls back all core files and metadata on ${name} failure`, async (t) => {
    const root = await fixture(t);
    await assert.rejects(withGameALock(root, () => commitGameATransaction(root, {
      planId: "example", entries: entries(),
      hooks: { [after ? "afterInstall" : "beforeInstall"]: (_entry, index) => { if (index === failIndex) throw new Error("injected failure"); } },
    })), /injected failure/);
    await assertRestored(root);
  });
}

test("rollback failure preserves backups, blocks readers/builds, and can be recovered repeatedly", async (t) => {
  const root = await fixture(t);
  await assert.rejects(withGameALock(root, () => commitGameATransaction(root, {
    planId: "example", entries: entries(), hooks: {
      beforeInstall: (_entry, index) => { if (index === 1) throw new Error("write failed"); },
      beforeRollback: () => { throw new Error("file locked during rollback"); },
    },
  })), /已保留备份/);
  const journal = JSON.parse(await readFile(path.join(journalRoot(root), "journal.json"), "utf8"));
  assert.equal(journal.state, "recovery-required");
  assert.equal(await readFile(path.join(journalRoot(root), "0.before"), "utf8"), "original");
  assert.throws(() => readGameAConsistently(root, () => "unsafe read"), /未完成/);
  await assert.rejects(withGameALock(root, () => assertGameAReadable(root)), /未完成/);
  const core = createCoopAgentCore({ repoRoot: root, commandRunner: () => { throw new Error("must not launch"); } });
  await assert.rejects(core.projectStatus(), /未完成/);
  await assert.rejects(core.buildGameA({}), /未完成/);
  assert.throws(() => createCoopSearch({ repoRoot: root }).execute({ operation: "patches.for_target", target: "catalog/Unit/Test" }), /未完成/);
  assert.equal((await recoverGameATransaction(root)).status, "rolled-back");
  await assertRestored(root);
  assert.equal((await recoverGameATransaction(root)).status, "clean");
});

test("recovery will not overwrite an unrelated edit or discard its backups", async (t) => {
  const root = await fixture(t);
  await assert.rejects(withGameALock(root, () => commitGameATransaction(root, {
    planId: "example", entries: entries(), hooks: {
      afterInstall: async (_entry, index) => {
        if (index === 0) { await writeFile(path.join(root, targets[0]), "user edit"); throw new Error("interrupted"); }
      },
    },
  })), /事务外发生变化/);
  await assert.rejects(recoverGameATransaction(root), /事务外发生变化/);
  assert.equal(await readFile(path.join(root, targets[0]), "utf8"), "user edit");
  assert.equal(existsSync(path.join(journalRoot(root), "0.before")), true);
});

test("commit includes file deletion and preserves pre-existing plan/receipt files on failure", async (t) => {
  const root = await fixture(t);
  const changes = entries();
  changes[0].bytes = null;
  await mkdir(path.dirname(path.join(root, targets[2])), { recursive: true });
  await writeFile(path.join(root, targets[2]), "existing plan");
  await assert.rejects(withGameALock(root, () => commitGameATransaction(root, {
    planId: "example", entries: changes,
    hooks: { beforeInstall: (_entry, index) => { if (index === 3) throw new Error("failed"); } },
  })), /failed/);
  assert.equal(await readFile(path.join(root, targets[0]), "utf8"), "original");
  assert.equal(await readFile(path.join(root, targets[2]), "utf8"), "existing plan");
});

test("project lock is cross-process and releasing an old guard cannot release a new one", async (t) => {
  const root = await fixture(t);
  const release = acquireGameALock(root);
  const module = new URL("../lib/game-a-transaction.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {acquireGameALock} from ${JSON.stringify(module)};
    try { acquireGameALock(${JSON.stringify(root)})(); process.exit(2); }
    catch(e) { process.exit(e.code === 'project-busy' ? 0 : 3); }
  `], { windowsHide: true, stdio: "ignore" });
  try { assert.equal((await once(child, "exit"))[0], 0); } finally { release(); }
  const newer = acquireGameALock(root);
  release();
  assert.throws(() => acquireGameALock(root), /正在/);
  newer();
});

test("consistent readers can coexist but cannot overlap a writer", async (t) => {
  const root = await fixture(t);
  const first = acquireGameALock(root, { readOnly: true });
  const second = acquireGameALock(root, { readOnly: true });
  assert.throws(() => acquireGameALock(root), /正在/);
  first();
  second();
  const writer = acquireGameALock(root);
  assert.throws(() => readGameAConsistently(root, () => "unsafe"), /正在/);
  writer();
});

test("killed process releases the lock but leaves a recoverable transaction", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  const module = new URL("../lib/game-a-transaction.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {withGameALock,commitGameATransaction} from ${JSON.stringify(module)};
    await withGameALock(${JSON.stringify(root)}, () => commitGameATransaction(${JSON.stringify(root)}, {
      planId:'example', entries:${JSON.stringify(targets)}.map((target,index)=>({target,bytes:Buffer.from('after-'+index)})),
      hooks:{afterInstall:async (_entry,index)=>{if(index===0){setInterval(()=>{},1000);process.stdout.write('READY');await new Promise(()=>{});}}}
    }));
  `], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("child exited before checkpoint")));
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("READY")) resolve(); });
  });
  assert.throws(() => acquireGameALock(root), /正在/);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.throws(() => readGameAConsistently(root, () => null), /未完成/);
  await recoverGameATransaction(root);
  await assertRestored(root);
});

test("malformed recovery records fail closed and completed commits remain usable", async (t) => {
  const root = await fixture(t);
  await withGameALock(root, () => commitGameATransaction(root, { planId: "example", entries: entries() }));
  assert.equal(await readFile(path.join(root, targets[3]), "utf8"), "after-3");
  assert.equal(readGameAConsistently(root, () => "ok"), "ok");
  await mkdir(journalRoot(root), { recursive: true });
  await writeFile(path.join(journalRoot(root), "journal.json"), "broken json");
  await assert.rejects(recoverGameATransaction(root), /不可读/);
  assert.equal(existsSync(journalRoot(root)), true);
});
