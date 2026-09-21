import assert from "node:assert/strict";
import { before, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFileSync } from 'node:fs';
import path from "node:path";
import { agentTestSource, agentTestBinary, agentTestLaunchOptions, createAgentTestClient } from "../lib/agent-test-client.mjs";

let projectRoot;
before(() => {
  if (process.env.COOPAGENT_AGENT_TEST_PROJECT) { projectRoot = path.resolve(process.env.COOPAGENT_AGENT_TEST_PROJECT); return; }
  const init = spawnSync(process.execPath, ["scripts/agent-regression.mjs", "init"], { cwd: agentTestSource, encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  projectRoot = JSON.parse(init.stdout.trim()).root;
});

test("headless interface shares the desktop snapshot and rejects unsafe requests without calling a model", async () => {
  const events = [];
  const client = await createAgentTestClient({ projectRoot, onEvent: (event) => events.push(event) });
  try {
    assert.equal(client.ready.projectRoot, projectRoot);
    assert.equal(client.ready.protocolVersion, 1);
    assert.equal(client.ready.mode, "headless");
    assert.ok(!client.ready.methods.includes("window.reload"));
    const snapshots = await Promise.all(Array.from({ length: 5 }, () => client.call("status")));
    assert.ok(snapshots.every((snapshot) => !snapshot.busy && snapshot.run === null));
    await assert.rejects(client.call("start", { prompt: "" }), /empty/i);
    await assert.rejects(client.call("start", { prompt: "test", bypass: true }), /unknown field/i);
    await assert.rejects(client.call("stop", { runId: "not-owned" }), /结束|切换/);
    await assert.rejects(client.call("status", { projectRoot: agentTestSource }), /does not accept/i);
    await assert.rejects(client.call("retry", { preparationId: "invalid" }), /Invalid preparationId/);
    await assert.rejects(client.call("open_game"), /Unknown method/);
    await assert.rejects(client.call("window.reload"), /requires desktop mode/);
    const jobs = await client.call("jobs");
    const fixture = JSON.parse(readFileSync(path.join(projectRoot, '../fixture.json'), 'utf8'));
    if (fixture.isolation?.mode === 'blind') assert.deepEqual(jobs, [], 'blind fixtures must not contain an initial-state plan or historical job');
    else assert.ok(jobs.some((job) => job.state === "applied"));
    assert.equal(events.length, 0);
  } finally { assert.equal((await client.close()).code, 0); }
});

test("both client and Rust host reject the original workspace as a test target", async () => {
  for (const mode of ["headless", "desktop"]) {
    await assert.rejects(agentTestLaunchOptions(agentTestSource, mode), /isolated/i);
    const child = spawnSync(agentTestBinary, mode === "desktop" ? ["--desktop"] : [], {
      windowsHide: true, encoding: "utf8", timeout: 10000,
      env: { ...process.env, COOPAGENT_TEST_PROJECT_ROOT: agentTestSource } });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /isolated/i);
    assert.equal(child.stdout, "");
  }
});

test("desktop mode is explicit and isolates its WebView data without opening a window", async () => {
  const headless = await agentTestLaunchOptions(projectRoot);
  const desktop = await agentTestLaunchOptions(projectRoot, "desktop");
  assert.deepEqual(headless.args, []);
  assert.deepEqual(desktop.args, ["--desktop"]);
  assert.equal(desktop.options.env.COOPAGENT_TEST_PROJECT_ROOT, projectRoot);
  assert.equal(desktop.options.env.WEBVIEW2_USER_DATA_FOLDER, path.join(projectRoot, "../webview-profile"));
  await assert.rejects(agentTestLaunchOptions(projectRoot, "unknown"), /mode must be/);
});

test("malformed JSON does not break framing; EOF closes an idle headless host", async () => {
  const launch = await agentTestLaunchOptions(projectRoot);
  const child = spawn(launch.binary, [], { ...launch.options, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  const messages = [];
  reader.on("line", (line) => {
    const value = JSON.parse(line); messages.push(value);
    if (value.ready) child.stdin.end('not json\n{"id":"after-error","method":"status"}\n');
  });
  const [code] = await closed;
  assert.equal(code, 0);
  assert.ok(messages.some((message) => message.id === null && message.error));
  assert.equal(messages.find((message) => message.id === "after-error").result.busy, false);
});

test("CLI stdio forwards protocol lines and exits after shutdown without waiting for terminal input", async () => {
  const child = spawn(process.execPath, ["scripts/agent-test.mjs", "stdio", "--project", projectRoot], {
    cwd: agentTestSource, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const messages = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const value = JSON.parse(line); messages.push(value);
    if (value.ready) child.stdin.write('{"id":"done","method":"shutdown"}\n');
  });
  const [code] = await closed;
  assert.equal(code, 0);
  assert.equal(messages.find((message) => message.id === "done").result.stopped, true);
});
