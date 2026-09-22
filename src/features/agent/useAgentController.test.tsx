import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAgentController, type AgentController } from "./useAgentController";
import type { AgentEvent, AgentRunSnapshot, AgentStatus, SubmissionJob, AgentTask } from "./types";
import { messagesFromSnapshot } from "./run-snapshot";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: (event: AgentEvent) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: bridge.invoke,
  Channel: class {
    onmessage = (_event: AgentEvent) => {};
    constructor() { bridge.channels.push(this); }
  },
}));

let root: Root;
let container: HTMLDivElement;
let agent: AgentController;
let status: AgentStatus;
let jobs: SubmissionJob[];
let savedTask: AgentTask | null;
const run = (overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot => ({
  runId: "run-1", tracePath: "trace-1", prompt: "龙骑士生命改为300", startedAtMs: 1000,
  sessionId: "session-1", state: "running", text: "正在查询", activity: "读取单位", sequence: 1,
  ...overrides,
});
const job = (state: SubmissionJob["state"]): SubmissionJob => ({
  preparationId: "prepared-1", state, runId: "run-1", updatedAt: state,
  prepared: {
    status: "applied", runId: "run-1", tracePath: "trace-1", planPath: "draft.json", planSha256: "sha",
    report: { id: "plan-1", operations: [{}, {}], changedFiles: ["UpgradeData.xml"], receiptRecord: "receipt.json" },
  },
});

function Harness() {
  agent = useAgentController(true);
  return <>
    <button disabled={!agent.agentRunning || agent.isCancelling} onClick={() => void agent.cancelAgent()}>停止</button>
    <output data-testid="busy">{String(agent.isThinking)}</output>
    <output data-testid="messages">{agent.messages.map((message) => message.text).join("\n")}</output>
    <output data-testid="usage">{JSON.stringify(agent.sessionUsage)}</output>
  </>;
}

async function flush() { await act(async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); }); }
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await flush();
}
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); await flush(); }
function backend(command: string) {
  if (command === "agent_task_status") return Promise.resolve(structuredClone(savedTask));
  if (command === "agent_snapshot") return Promise.resolve(structuredClone(status));
  if (command === "plan_submission_status") return Promise.resolve(structuredClone(jobs));
  if (command === "agent_session_list") return Promise.resolve([]);
  if (command === "agent_cancel" || command === "agent_start") return Promise.resolve({});
  throw new Error(`Unexpected command: ${command}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  status = { busy: false, run: null };
  jobs = [];
  savedTask = null;
  bridge.channels.length = 0;
  bridge.invoke.mockReset().mockImplementation(backend);
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a reloaded page recovers text and can stop the original backend run without a Channel", async () => {
  status = { busy: true, run: run() };
  await mount();
  expect(bridge.channels).toHaveLength(0);
  expect(agent.agentRunning).toBe(true);
  expect(container.textContent).toContain("正在查询");
  await act(async () => container.querySelector("button")!.click());
  expect(bridge.invoke).toHaveBeenCalledWith("agent_cancel", { runId: "run-1" });
  expect(agent.isThinking).toBe(true);
  expect(agent.isCancelling).toBe(true);
  status = { busy: false, run: run({ state: "cancelled", error: "已停止", sequence: 2 }) };
  await poll();
  expect(agent.agentRunning).toBe(false);
  expect(agent.isThinking).toBe(false);
  expect(agent.isCancelling).toBe(false);
  expect(container.textContent).toContain("已停止");
});

test("generic waiting uses themed copy while concrete activity and model text remain intact", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  await mount();
  await act(async () => agent.setDraft("查询单位生命"));
  await act(async () => agent.sendMessage());
  const channel = bridge.channels[bridge.channels.length - 1];
  const latest = () => agent.messages[agent.messages.length - 1];
  expect(latest().thinkingHint).toBe("正在采集晶体矿…");
  for (const label of ["正在启动 Agent…", "正在分析项目…"]) {
    await act(async () => channel.onmessage({ type: "activity", label }));
    expect(latest().thinkingHint).toBe("正在采集晶体矿…");
  }
  for (const label of ["正在调用 coop_search…", "我需要确认当前项目中的生命值。", "正在完成最终收尾…"]) {
    await act(async () => channel.onmessage({ type: "activity", label }));
    expect(latest().thinkingHint).toBe(label);
    expect(latest().status).toBe("thinking");
  }
  await act(async () => channel.onmessage({ type: "text", text: "当前生命值为45。" }));
  await act(async () => channel.onmessage({ type: "activity", label: "正在分析项目…" }));
  expect(latest().text).toBe("当前生命值为45。");
  expect(latest().status).toBeUndefined();
});

test('live and recovered failures preserve partial replies and keep the technical error separate', async () => {
  await mount();
  await act(async () => agent.setDraft('查询生命'));
  await act(async () => agent.sendMessage());
  const channel = bridge.channels[bridge.channels.length - 1];
  await act(async () => channel.onmessage({ type: 'text', text: '已找到目标单位。' }));
  const error = 'HTTP 401 Authorization Required\nupstream stack trace';
  await act(async () => channel.onmessage({ type: 'error', runId: 'run-1', message: error }));
  const latest = agent.messages[agent.messages.length - 1];
  expect(latest.text).toBe('已找到目标单位。');
  expect(latest.errorDetails).toBe(error);
  const recovered = messagesFromSnapshot([], run({ state: 'failed', text: latest.text, error }));
  expect(recovered[recovered.length - 1]?.errorDetails).toBe(error);
  expect(recovered[recovered.length - 1]?.text).toBe(latest.text);
  const cancelled = messagesFromSnapshot([], run({ state: 'cancelled', text: '', error: '已停止' }));
  expect(cancelled[cancelled.length - 1]?.text).toBe('已停止');
  expect(cancelled[cancelled.length - 1]?.errorDetails).toBeUndefined();
});

test("restored waiting has stable themed copy and preserves real activity and final replies", () => {
  vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValue(0.9);
  const waiting = run({ text: "", activity: "正在分析项目…" });
  const messages = messagesFromSnapshot([], waiting);
  expect(messages[messages.length - 1]?.thinkingHint).toBe("正在采集晶体矿…");
  expect(messagesFromSnapshot(messages, waiting)).toEqual(messages);
  const working = messagesFromSnapshot(messages, run({ text: "", activity: "正在调用 coop_search…" }));
  expect(working[working.length - 1]?.thinkingHint).toBe("正在调用 coop_search…");
  const completed = messagesFromSnapshot(working, run({ state: "completed", text: "当前生命值为45。" }));
  expect(completed[completed.length - 1]?.text).toBe("当前生命值为45。");
  expect(completed[completed.length - 1]?.status).toBeUndefined();
});

test("session history restores token totals and live steps accumulate into the latest turn", async () => {
  localStorage.setItem("coopagent-active-session-id", "session-usage");
  bridge.invoke.mockImplementation((command, args) => {
    if (command === "agent_session_list") return Promise.resolve([{ id: "session-usage", title: "用量测试" }]);
    if (command === "agent_session_read") return Promise.resolve({
      id: args.sessionId,
      messages: [{ id: "u1", role: "user", text: "上一轮" }],
      usage: {
        lastTurn: { input: 40, cached: 80, output: 12 },
        total: { input: 100, cached: 300, output: 25 },
      },
    });
    return backend(command);
  });
  await mount();
  expect(agent.sessionUsage).toEqual({
    lastTurn: { input: 40, cached: 80, output: 12 },
    total: { input: 100, cached: 300, output: 25 },
  });

  await act(async () => agent.setDraft("新一轮"));
  await act(async () => agent.sendMessage());
  const channel = bridge.channels[bridge.channels.length - 1];
  await act(async () => channel.onmessage({
    type: "usage",
    sessionId: "session-usage",
    tokens: { input: 10, cached: 20, output: 3 },
  }));
  await act(async () => channel.onmessage({
    type: "usage",
    sessionId: "session-usage",
    tokens: { input: 5, cached: 7, output: 2 },
  }));
  expect(agent.sessionUsage).toEqual({
    lastTurn: { input: 15, cached: 27, output: 5 },
    total: { input: 115, cached: 327, output: 30 },
  });
});

test("saved paused progress survives a page reload and resume passes task ID without applying anything", async () => {
  savedTask = { id: 'task-old', runId: 'run-old', prompt: '原始修改需求', phase: 2, status: 'paused',
    draftPath: 'game-a/drafts/example.patch-plan.json', selectedPreparation: null,
    lastCheckpoint: { summary: '已确认武器', remaining: ['生产入口'], nextAction: '确认生产入口', source: 'agent' } };
  await mount();
  expect(agent.task?.lastCheckpoint?.summary).toBe('已确认武器');
  expect(agent.isThinking).toBe(false);
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'agent_start')).toBe(false);
  await act(async () => agent.resumeTask());
  const start = bridge.invoke.mock.calls.find(([command]) => command === 'agent_start');
  expect(start?.[1].taskId).toBe('task-old');
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'plan_submission_retry')).toBe(false);
});

function waitingTask(): AgentTask {
  return { id: 'task-confirm', runId: 'run-old', prompt: '修改10级升级', phase: 1, status: 'awaiting_confirmation',
    draftPath: null, selectedPreparation: null,
    confirmation: { question: '你要改建造加速吗？', target: '10级升级', currentEffect: '50%', proposedEffect: '25%', reason: '名称不同' },
    lastCheckpoint: { summary: '你要改建造加速吗？', remaining: [], nextAction: '等待回复', source: 'agent' } };
}

test('restoring the original session retains its pending confirmation; another session does not inherit it', async () => {
  savedTask = { ...waitingTask(), modelSessionId: 'session-confirm' };
  localStorage.setItem('coopagent-active-session-id', 'session-confirm');
  bridge.invoke.mockImplementation((command, args) => {
    if (command === 'agent_session_list') return Promise.resolve([{ id: 'session-confirm', title: '待确认' }]);
    if (command === 'agent_session_read') return Promise.resolve({ id: args.sessionId, messages: [] });
    return backend(command);
  });
  await mount();
  expect(agent.task?.id).toBe(savedTask.id);
  expect(agent.task?.status).toBe('awaiting_confirmation');
  await act(async () => agent.readAgentSession('another-session'));
  expect(agent.task).toBeNull();
  await act(async () => agent.readAgentSession('session-confirm'));
  expect(agent.task?.id).toBe(savedTask.id);
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'agent_start')).toBe(false);
});

test.each(['我是 CoopAgent，可以帮你修改合作模式的数值。', '生命已从45改为60；面板文字尚未同步。'])
('sealed answer replaces progress on the live page: %s', async (reply) => {
  await mount();
  await act(async () => agent.setDraft('请回答'));
  await act(async () => agent.sendMessage());
  const channel = bridge.channels[bridge.channels.length - 1];
  await act(async () => channel.onmessage({ type: 'text', text: '正在处理请求' }));
  const task: AgentTask = { ...waitingTask(), status: 'ended', confirmation: null,
    checkpoint: { disposition: 'deliver', summary: reply },
    lastCheckpoint: { summary: reply, remaining: [], nextAction: '等待反馈', source: 'agent' } };
  await act(async () => channel.onmessage({ type: 'phase', task }));
  await act(async () => channel.onmessage({ type: 'complete', runId: 'run-1', sessionId: 'session-1' }));
  expect(agent.messages[agent.messages.length - 1]?.text).toBe(reply);
  expect(container.textContent).not.toContain('正在处理请求');
});

test('waiting target survives reload without auto-start; a free-text correction resumes the same task', async () => {
  savedTask = waitingTask();
  await mount();
  expect(agent.task?.confirmation?.proposedEffect).toBe('25%');
  expect(agent.isThinking).toBe(false);
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'agent_start')).toBe(false);
  await act(async () => agent.setDraft('不是这个，我说的是训练加速'));
  await act(async () => agent.sendMessage());
  expect(bridge.invoke).toHaveBeenCalledWith('agent_start', expect.objectContaining({ taskId: 'task-confirm', prompt: '不是这个，我说的是训练加速' }));
});

test('explicit target confirmation resumes with an answer; empty generic resume does nothing', async () => {
  savedTask = waitingTask(); await mount();
  await act(async () => agent.resumeTask());
  expect(bridge.invoke.mock.calls.some(([command]) => command === 'agent_start')).toBe(false);
  await act(async () => agent.confirmTarget());
  expect(bridge.invoke).toHaveBeenCalledWith('agent_start', expect.objectContaining({ taskId: 'task-confirm', prompt: '是，按上述目标和效果修改。' }));
});

test('a new session does not accidentally answer the previous confirmation', async () => {
  savedTask = waitingTask(); await mount();
  await act(async () => agent.beginNewAgentSession());
  await act(async () => agent.setDraft('雷诺枪兵生命改为60'));
  await act(async () => agent.sendMessage());
  expect(bridge.invoke).toHaveBeenCalledWith('agent_start', expect.objectContaining({ taskId: null, prompt: '雷诺枪兵生命改为60' }));
});

test("remounting during generation never replays a start or loses the latest absolute text", async () => {
  status = { busy: true, run: run() };
  await mount();
  await act(async () => root.unmount());
  container.remove();
  status.run = run({ text: "查询完成，准备计划", sequence: 3 });
  await mount();
  await poll();
  expect(agent.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(agent.messages.filter((message) => message.text === "查询完成，准备计划")).toHaveLength(1);
  expect(bridge.invoke.mock.calls.some(([command]) => command === "agent_start")).toBe(false);
});

test("model completion does not unlock the page while a durable submission is still applying", async () => {
  status = { busy: true, run: run() };
  jobs = [job("applying")];
  await mount();
  status = { busy: false, run: run({ state: "completed", text: "已提交", sequence: 2 }) };
  await poll();
  expect(agent.agentRunning).toBe(false);
  expect(agent.isThinking).toBe(true);
  expect(agent.isApplying).toBe(true);
  await act(async () => agent.setDraft("下一轮"));
  await act(async () => agent.sendMessage());
  expect(bridge.invoke.mock.calls.some(([command]) => command === "agent_start")).toBe(false);
  jobs = [job("applied")];
  await poll();
  expect(agent.isThinking).toBe(false);
  expect(agent.pendingPlan?.status).toBe("applied");
});

test("a stale completed snapshot cannot replace a restored historical conversation", async () => {
  status = { busy: false, run: run({ state: "completed", text: "旧任务输出" }) };
  localStorage.setItem("coopagent-active-session-id", "history-session");
  bridge.invoke.mockImplementation((command) => {
    if (command === "agent_session_list") return Promise.resolve([{ id: "history-session", title: "旧会话" }]);
    if (command === "agent_session_read") return Promise.resolve({ id: "history-session", messages: [{ id: "h1", role: "user", text: "保留历史" }] });
    return backend(command);
  });
  await mount();
  await poll();
  expect(agent.activeSessionId).toBe("history-session");
  expect(container.textContent).toContain("保留历史");
  expect(container.textContent).not.toContain("旧任务输出");
});

test("a failed first observation remains gated and retries until the active run is recovered", async () => {
  let unavailable = true;
  status = { busy: true, run: run() };
  bridge.invoke.mockImplementation((command) => command === "agent_snapshot" && unavailable
    ? Promise.reject(new Error("temporary IPC failure")) : backend(command));
  await mount();
  expect(agent.sessionInitializing).toBe(true);
  await act(async () => agent.setDraft("不可重复发送"));
  await act(async () => agent.sendMessage());
  expect(bridge.channels).toHaveLength(0);
  unavailable = false;
  await poll();
  expect(agent.sessionInitializing).toBe(false);
  expect(agent.agentRunning).toBe(true);
});

test("an old in-flight idle read cannot clear a newly started run", async () => {
  await mount();
  let resolveOld!: (value: AgentStatus) => void;
  const oldRead = new Promise<AgentStatus>((resolve) => { resolveOld = resolve; });
  bridge.invoke.mockImplementation((command) => command === "agent_snapshot" ? oldRead : backend(command));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => agent.setDraft("新修改"));
  await act(async () => agent.sendMessage());
  await act(async () => bridge.channels[0].onmessage({ type: "started", runId: "new-run", tracePath: "new-trace" }));
  await act(async () => resolveOld({ busy: false, run: null }));
  await flush();
  expect(agent.isThinking).toBe(true);
  expect(agent.agentRunning).toBe(true);
});

test("storage failure cannot interrupt terminal event handling or leave the page stuck", async () => {
  await mount();
  await act(async () => agent.setDraft("测试"));
  await act(async () => agent.sendMessage());
  const channel = bridge.channels[0];
  await act(async () => channel.onmessage({ type: "started", runId: "new-run", tracePath: "trace" }));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await act(async () => channel.onmessage({ type: "complete", runId: "new-run", sessionId: "session-new" }));
  await poll();
  expect(agent.agentRunning).toBe(false);
  expect(agent.isThinking).toBe(false);
  expect(agent.activeSessionId).toBe("session-new");
});

test("retry IPC failure remains busy until backend job state proves the outcome", async () => {
  jobs = [job("failed")];
  await mount();
  let unavailable = true;
  bridge.invoke.mockImplementation((command) => {
    if (command === "plan_submission_retry") { jobs = [job("applying")]; return Promise.reject(new Error("lost reply")); }
    if (command === "plan_submission_status" && unavailable) return Promise.reject(new Error("unavailable"));
    return backend(command);
  });
  await act(async () => agent.applyPendingPlan());
  expect(agent.isThinking).toBe(true);
  expect(agent.pendingPlan?.status).toBe("applying");
  jobs = [job("applied")];
  unavailable = false;
  await poll();
  expect(agent.isThinking).toBe(false);
  expect(agent.pendingPlan?.status).toBe("applied");
});

test("snapshot history reconciliation preserves earlier identical requests and replaces only this run's tail", () => {
  const messages = [
    { id: "old", role: "user" as const, text: run().prompt, createdAtMs: 900 },
    { id: "old-response", role: "assistant" as const, text: "上次结果" },
    { id: "new", role: "user" as const, text: run().prompt, createdAtMs: 1100 },
    { id: "partial", role: "assistant" as const, text: "旧片段" },
  ];
  const result = messagesFromSnapshot(messages, run());
  expect(result.map((message) => message.id)).toEqual(["old", "old-response", "run-run-1-user", "run-run-1-response"]);
  expect(messagesFromSnapshot(result, run())).toEqual(result);
});
