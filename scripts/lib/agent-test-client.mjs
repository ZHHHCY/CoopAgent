import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { blindTestEnvironment } from './blind-fixture.mjs';

export const agentTestSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const agentTestTarget = path.join(agentTestSource, ".tools/desktop-test-target");
export const agentTestBinary = path.join(agentTestTarget, "debug", process.platform === "win32" ? "coopagent-agent-test.exe" : "coopagent-agent-test");

export async function agentTestLaunchOptions(projectRoot, mode = "headless") {
  if (!["headless", "desktop"].includes(mode)) throw Error("mode must be headless or desktop");
  if (!projectRoot) throw Error("--project is required; create an isolated project with agent:test init first");
  projectRoot = path.resolve(projectRoot);
  const allowed = await realpath(path.join(agentTestSource, ".tools/agent-regressions"));
  const resolved = await realpath(projectRoot);
  const relative = path.relative(allowed, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)
      || path.basename(projectRoot) !== "project") throw Error("Only marked isolated regression projects are allowed");
  const fixture = JSON.parse(await readFile(path.join(projectRoot, "../fixture.json"), "utf8"));
  if (fixture.root !== projectRoot || fixture.source !== agentTestSource) throw Error("Regression fixture identity mismatch");
  if (!existsSync(agentTestBinary)) throw Error("Test backend is not built; run pnpm agent:test build first");
  return { projectRoot, binary: agentTestBinary, args: mode === "desktop" ? ["--desktop"] : [], options: {
    cwd: projectRoot, windowsHide: true,
    env: { ...process.env, COOPAGENT_TEST_PROJECT_ROOT: projectRoot,
      ...(fixture.isolation?.mode === 'blind' ? blindTestEnvironment(projectRoot) : {}),
      COOPAGENT_DATABASE: fixture.databaseFile, COOPAGENT_CATALOG_ROOT: fixture.catalogRoot,
      ...(mode === "desktop" ? { WEBVIEW2_USER_DATA_FOLDER: path.join(projectRoot, "../webview-profile") } : {}) },
  } };
}

/** Reusable test API. Requests and events are separate JSON lines; a timed-out
 * observation never kills or restarts the model/committer. No network listener. */
export async function createAgentTestClient({ projectRoot, mode = "headless", onEvent = () => {}, onStderr = () => {} }) {
  const launch = await agentTestLaunchOptions(projectRoot, mode);
  // Isolate terminal signals: Ctrl+C belongs to the client, which persists a
  // cancellation barrier via RPC instead of killing the Rust host mid-run.
  const child = spawn(launch.binary, launch.args, { ...launch.options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0, terminal = false, startupResolve, startupReject, exitResolve;
  const ready = new Promise((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  const exited = new Promise((resolve) => { exitResolve = resolve; });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { startupReject(Error("Invalid JSON from test backend")); return; }
    if (message.ready) { startupResolve(message); return; }
    if (message.event) { onEvent(message.event); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  });
  child.stderr.on("data", (chunk) => onStderr(chunk.toString()));
  child.on("error", (error) => startupReject(error));
  child.stdin.on("error", (error) => { for (const request of pending.values()) request.reject(error); });
  child.on("close", (code, signal) => {
    terminal = true;
    const error = Error(`Test backend exited (${code ?? signal})`);
    startupReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); exitResolve({ code, signal });
  });
  const call = (method, params = {}, { timeoutMs = 20000 } = {}) => new Promise((resolve, reject) => {
    if (terminal) { reject(Error("Test backend has exited")); return; }
    const id = String(++nextId);
    const timer = setTimeout(() => {
      pending.delete(id); reject(Error(`Observation timed out: ${method}; backend outcome is unknown (not cancelled)`));
    }, timeoutMs);
    timer.unref();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return { ready: await ready, pid: child.pid, call, exited,
    async close() {
      if (!terminal) {
        try { await call("shutdown", {}, { timeoutMs: 25000 }); }
        finally { child.stdin.end(); } // EOF still requests cleanup if the reply was lost.
      }
      return exited;
    },
  };
}
