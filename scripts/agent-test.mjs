#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { agentTestSource, agentTestTarget, agentTestLaunchOptions, createAgentTestClient } from "./lib/agent-test-client.mjs";

const help = `CoopAgent test interface (isolated projects; headless by default; no game launch)
  pnpm agent:test build
  pnpm agent:test init [--blind]
  pnpm agent:test run --project <project> --prompt "把阿塔尼斯龙骑士生命改为300"
      [--session <sessionId>] [--task <saved-task-id>] [--stop-after-ms 3000] [--timeout-ms 2100000] [--mode desktop]
  pnpm agent:test stdio --project <project> [--mode desktop]
Desktop mode requires the frontend dev server (pnpm dev).
run has no timeout by default; --timeout-ms explicitly sets an overall limit.
When a task awaits target confirmation, resume with --task <id> --prompt "your answer or correction".

stdio requests (one JSON object per line):
  {"id":"1","method":"start","params":{"prompt":"修改需求","sessionId":null}}
  {"id":"2","method":"status"}
  {"id":"3","method":"stop","params":{"runId":"returned runId"}}
  {"id":"4","method":"jobs"}
  {"id":"5","method":"retry","params":{"preparationId":"returned preparationId"}}
  {"id":"6","method":"shutdown"}
run uses the configured model API; it may incur usage charges. Ctrl+C requests safe cancellation.`;

function argsOf(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!["--project", "--prompt", "--session", "--task", "--stop-after-ms", "--timeout-ms", "--mode"].includes(key) || args[i + 1] == null) {
      throw Error(`Invalid argument ${key}\n${help}`);
    }
    if (key in options) throw Error(`Duplicate option: ${key}`);
    options[key] = args[i + 1];
  }
  for (const key of ["--stop-after-ms", "--timeout-ms"]) {
    if (options[key] != null && (!/^\d+$/.test(options[key]) || Number(options[key]) < 1 || Number(options[key]) > 3600000)) {
      throw Error(`${key} must be 1–3600000`);
    }
  }
  return options;
}

async function invokeProgram(program, args, options = {}) {
  const child = spawn(program, args, { cwd: agentTestSource, windowsHide: true, stdio: "inherit", ...options });
  const [code, signal] = await once(child, "close");
  if (signal) throw Error(`Command terminated by ${signal}`);
  process.exitCode = code ?? 1;
}

async function stdio(projectRoot, mode) {
  const launch = await agentTestLaunchOptions(projectRoot, mode);
  const child = spawn(launch.binary, launch.args, { ...launch.options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  // Forward raw JSON without taking terminal Ctrl+C into the Rust host.
  // EOF/shutdown lets that host persist cancellation and reap its model.
  const stop = () => { process.stdin.unpipe(child.stdin); child.stdin.end(); };
  process.on("SIGINT", stop);
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") console.error(error.message); });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  try { const [code] = await closed; process.exitCode = code ?? 1; }
  finally { process.off("SIGINT", stop); process.stdin.unpipe(child.stdin); process.stdin.pause(); }
}

async function run(options) {
  if (!options["--prompt"]?.trim() && !options["--task"]) throw Error("--prompt or --task is required");
  const launch = await agentTestLaunchOptions(options["--project"], options["--mode"]);
  const logPath = path.join(launch.projectRoot, "..", `agent-test-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: "wx" });
  await once(log, "open");
  const emit = (value) => { const line = `${JSON.stringify(value)}\n`; log.write(line); process.stdout.write(line); };
  let client, runId, stopTimer, stopRequested = false, interrupted = false;
  const stop = async () => {
    if (!client || !runId || stopRequested) return;
    stopRequested = true;
    try { emit({ stop: await client.call("stop", { runId }) }); }
    catch (error) { emit({ observationError: error.message }); }
  };
  const onSignal = () => { interrupted = true; void stop(); };
  process.on("SIGINT", onSignal);
  try {
    client = await createAgentTestClient({ projectRoot: launch.projectRoot, mode: options["--mode"],
      onEvent: (event) => { if (event.type === "started") runId = event.runId; emit({ event }); },
      onStderr: (stderr) => log.write(`${JSON.stringify({ stderr })}\n`),
    });
    emit({ ...client.ready, logPath, pid: client.pid });
    if (interrupted) { process.exitCode = 130; return; }
    const started = await client.call("start", { prompt: options["--prompt"] ?? "", sessionId: options["--session"] ?? null, taskId: options["--task"] ?? null });
    runId = started.run.runId;
    if (interrupted) await stop();
    if (options["--stop-after-ms"]) stopTimer = setTimeout(() => void stop(), Number(options["--stop-after-ms"]));
    const deadline = options["--timeout-ms"] == null ? Infinity : Date.now() + Number(options["--timeout-ms"]);
    while (true) {
      const state = await client.call("status");
      const live = state.run && ["starting", "running"].includes(state.run.state);
      if (!live && !state.busy) {
        const jobs = (await client.call("jobs")).filter((job) => job.runId === runId);
        const pending = jobs.some((job) => ["submitted", "applying"].includes(job.state));
        if (!pending || Date.now() >= deadline) {
          emit({ result: { run: state.run, pending,
            jobs: jobs.map((job) => ({ preparationId: job.preparationId, state: job.state,
              error: job.error, receiptPath: job.result?.report?.receiptRecord })), logPath } });
          process.exitCode = pending ? 3 : state.run?.state === "paused" ? 2 : state.run?.state === "cancelled" ? 130
            : state.run?.state === "failed" || jobs.some((job) => job.state !== "applied") ? 1 : 0;
          break;
        }
      }
      if (live && Date.now() >= deadline) { await stop(); throw Error("Run timeout; cancellation requested. Inspect backend jobs for any already selected submission."); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    clearTimeout(stopTimer); process.off("SIGINT", onSignal);
    try { if (client) await client.close(); }
    finally { log.end(); await once(log, "finish"); }
  }
}

try {
  const [command = "help", ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (["help", "--help", "-h"].includes(command)) console.log(help);
  else if (command === "build") {
    if (args.length) throw Error("build does not accept arguments");
    const localCargo = path.join(agentTestSource, ".tools/cargo/bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    await invokeProgram(existsSync(localCargo) ? localCargo : "cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml", "--features", "agent-test", "--bin", "coopagent-agent-test"], {
      env: { ...process.env, CARGO_TARGET_DIR: agentTestTarget,
        ...(existsSync(localCargo) ? { CARGO_HOME: path.join(agentTestSource, ".tools/cargo"), RUSTUP_HOME: path.join(agentTestSource, ".tools/rustup") } : {}) },
    });
  } else if (command === "init") {
    if (args.length && (args.length !== 1 || args[0] !== '--blind')) throw Error("init accepts only --blind");
    await invokeProgram(process.execPath, ["scripts/agent-regression.mjs", "init", ...args]);
  } else if (command === "run") await run(argsOf(args));
  else if (command === "stdio") {
    const options = argsOf(args);
    if (Object.keys(options).some((key) => !["--project", "--mode"].includes(key))) throw Error("stdio only accepts --project and --mode");
    await stdio(options["--project"], options["--mode"]);
  } else throw Error(help);
} catch (error) { console.error(error.message); process.exitCode = 1; }
