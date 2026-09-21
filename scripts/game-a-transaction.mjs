#!/usr/bin/env node
import path from "node:path";
import { APP_ROOT, workspaceRoot } from "./lib/project-context.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertGameAReadable, recoverGameATransaction, withGameALock } from "./lib/game-a-transaction.mjs";

const repoRoot = workspaceRoot();
const [action, ...args] = process.argv.slice(2);
try {
  if (action === "recover") {
    console.log(JSON.stringify(await recoverGameATransaction(repoRoot)));
  } else if (action === "build") {
    await withGameALock(repoRoot, async () => {
      assertGameAReadable(repoRoot);
      const script = path.join(APP_ROOT, "game-a/scripts/build-game-a.ps1");
      const child = spawn(process.platform === "win32" ? "powershell.exe" : "pwsh", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
      ], {
        cwd: repoRoot, windowsHide: true, stdio: "inherit",
        env: { ...process.env, COOPAGENT_GAME_A_BUILD_LOCK: repoRoot },
      });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Game A build failed (${signal ?? code}).`)));
      });
    });
  } else throw new Error("Usage: node scripts/game-a-transaction.mjs recover | build [-HostId <id>] [-Check]");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
