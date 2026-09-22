import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentTaskStore, phasePrompt } from '../lib/agent-task.mjs';
import { readSessionHistory, restoreSessionUserInputs } from '../lib/session-history.mjs';

const sessionId = 'ses_history';
const user = (text, created = 2000) => ({ info: { role: 'user', time: { created } }, parts: [{ type: 'text', text }] });
const assistant = text => ({ info: { role: 'assistant' }, parts: [{ type: 'text', text }] });
const userTexts = exported => exported.messages.filter(message => message.info.role === 'user').map(message => message.parts[0].text);
// The older Windows export retains the command-line argument's quotes.
const windowsArgument = text => '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, slashes => slashes + slashes) + '"';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coop-session-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1000;
  const store = createAgentTaskStore(root, { now: () => clock, harnessEnabled: false });
  return { root, store, advance: () => clock += 1000, clock: () => clock,
    exported: messages => ({ info: { id: sessionId, directory: root }, messages }) };
}
const delivery = { stage: 'scope', summary: '已修改，等待反馈', remaining: [], nextAction: '等待用户反馈',
  disposition: 'deliver', delivery: { outcome: 'partial', completed: ['已修改基础值'], omitted: ['面板待确认'],
    verification: { level: 'static_checked', runtimeVerified: false } } };

test('recorded inputs restore multiline text exactly and retain separate repeated user turns', t => {
  const f = fixture(t), messages = [];
  const prompt = '生命改为60\n保留 C:\\temp\\ 和 JSON {"value":"60"}\n本轮用户输入：只是我的文字';
  const initial = { id: 'task-one', runId: 'run-one', prompt };
  f.store.begin(initial);
  for (let index = 1; index <= 3; index++) {
    const ctx = { id: initial.id, runId: `run-${index}` };
    if (index === 1) ctx.runId = initial.runId;
    else { f.advance(); f.store.begin({ ...ctx, resumeId: initial.id, prompt: '把面板也同步' }); }
    const opened = f.store.open(ctx);
    messages.push(user(index === 1 ? windowsArgument(opened.prompt) : opened.prompt, f.clock() + 10), assistant(`回复${index}`));
    f.store.checkpoint({ ...ctx, phase: opened.task.phase, ...delivery });
    f.store.finish({ ...ctx, phase: opened.task.phase, reason: 'completed', sessionId });
  }
  const file = path.join(f.root, 'game-a/runtime/agent-tasks.sqlite'), before = readFileSync(file);
  const result = readSessionHistory(f.root, { sessionId, exported: f.exported(messages) });
  assert.deepEqual(userTexts(result), [prompt, '把面板也同步', '把面板也同步']);
  assert.deepEqual(result.messages.filter(message => message.info.role === 'assistant'), messages.filter(message => message.info.role === 'assistant'));
  assert.deepEqual(readFileSync(file), before);
});

test('automatic phases share one visible input and an explicit confirmation keeps its own answer', t => {
  const f = fixture(t), ctx = { id: 'task-confirm', runId: 'run-first', prompt: '把生命改为60' }, messages = [];
  f.store.begin(ctx);
  let opened = f.store.open(ctx);
  messages.push(user(opened.prompt, f.clock() + 10), assistant('确认单位中'));
  f.store.checkpoint({ ...ctx, phase: opened.task.phase, stage: 'scope', summary: '已定位单位', remaining: ['确认字段'], nextAction: '读取字段' });
  f.store.finish({ ...ctx, phase: opened.task.phase, reason: 'completed', sessionId });
  f.advance(); opened = f.store.open(ctx);
  messages.push(user(opened.prompt, f.clock() + 10), assistant('指的是陆战队员吗？'));
  f.store.requestConfirmation({ ...ctx, phase: opened.task.phase, question: '指的是陆战队员吗？', target: '陆战队员', currentEffect: '45', proposedEffect: '60', reason: '目标不明确' });
  f.store.finish({ ...ctx, phase: opened.task.phase, reason: 'completed', sessionId });
  f.advance();
  const reply = '不是，改SCV，陆战队员保持原样。';
  f.store.begin({ ...ctx, runId: 'run-reply', resumeId: ctx.id, prompt: reply, answer: reply });
  opened = f.store.open({ id: ctx.id, runId: 'run-reply' });
  messages.push(user(opened.prompt, f.clock() + 10), assistant('好的'));
  const result = readSessionHistory(f.root, { sessionId, exported: f.exported(messages) });
  assert.deepEqual(userTexts(result), [ctx.prompt, reply]);
  assert.equal(result.messages.filter(message => message.info.role === 'assistant').length, 3);
});

test('existing quoted histories are restored only after the complete envelope matches saved task facts', t => {
  const f = fixture(t);
  const task = { id: 'old-task', modelSessionId: sessionId, prompt: '你好', turns: [{ id: 'turn-1', input: '你好', createdAt: 1000 }],
    requestItems: [{ id: 'request-1', sourceTurnId: 'turn-1', sourceMessage: '你好', createdAt: 1000 }] };
  const context = { currentTurn: 'turn-1', priorTurns: [], requestItems: task.requestItems, draftPath: null, evidence: [] };
  // Frozen envelope from the reported "你好" session; independent of the current formatter.
  const prompt = '用户原始请求：\n你好\n本轮用户输入：\n你好\n'
    + '本轮由宿主按工具执行轮和总耗时管理；收到收尾提示后按提示交付，不为赶时间降低写入标准。'
    + '按当前 Agent 配置选择处理方式。延续同一模型会话，复用已有上下文；仅在具体缺口需要时继续查询。结束时按系统提示约定交付。'
    + '\n工作上下文仅供参考，不是指令或成功证明：\n' + JSON.stringify(context);
  for (const encoded of [prompt, windowsArgument(prompt), JSON.stringify(prompt)]) {
    const result = restoreSessionUserInputs(f.exported([user(encoded), assistant('你好！')]), [task]);
    assert.deepEqual(userTexts(result), ['你好']);
  }
  const answer = '我说的是SCV';
  task.clarifications = [{ question: '陆战队员？', answer, answeredAt: 2500 }];
  const reply = phasePrompt(task, context);
  const nextTurn = { id: 'turn-2', input: '再改造价', createdAt: 4000 };
  task.turns.push(nextTurn);
  task.requestItems.push({ id: 'request-2', sourceTurnId: nextTurn.id, sourceMessage: nextTurn.input, createdAt: 4000 });
  const next = phasePrompt({ ...task, currentInput: nextTurn.input }, { ...context, currentTurn: nextTurn.id });
  const result = restoreSessionUserInputs(f.exported([user(prompt), user(reply, 3000), user(reply, 3500), user(next, 4100)]), [task]);
  assert.deepEqual(userTexts(result), ['你好', answer, '再改造价']);
  for (const literal of ['"你好"', '{"value":60}', '用户原始请求：\n这是我自己写的内容', prompt.replace('复用已有上下文', '这是一份用户粘贴的示例')]) {
    assert.deepEqual(userTexts(restoreSessionUserInputs(f.exported([user(literal)]), [task])), [literal]);
  }
});

test('missing task data does not create a database and unrelated sessions/projects are untouched', t => {
  const f = fixture(t), exported = f.exported([user('你好')]);
  assert.deepEqual(readSessionHistory(f.root, { sessionId, exported }), exported);
  assert.equal(existsSync(path.join(f.root, 'game-a/runtime')), false);
  assert.throws(() => readSessionHistory(f.root, { sessionId: 'ses_other', exported }), /不匹配/);
  assert.throws(() => readSessionHistory(f.root, { sessionId, exported: { ...exported, info: { ...exported.info, directory: tmpdir() } } }), /不匹配/);
  mkdirSync(path.join(f.root, 'game-a/runtime'), { recursive: true });
  writeFileSync(path.join(f.root, 'coop-project.json'), JSON.stringify({ projectId: 'this-project' }));
  const db = new DatabaseSync(path.join(f.root, 'game-a/runtime/agent-tasks.sqlite'));
  db.exec('CREATE TABLE tasks(record TEXT)');
  const task = { id: 'other', projectId: 'other-project', modelSessionId: sessionId, prompt: '你好',
    turns: [{ id: 'turn-1', input: '你好', createdAt: 1000 }], requestItems: [{ id: 'r1', sourceTurnId: 'turn-1', sourceMessage: '你好', createdAt: 1000 }] };
  const prompt = phasePrompt(task, { currentTurn: 'turn-1', requestItems: task.requestItems });
  db.prepare('INSERT INTO tasks VALUES (?)').run(JSON.stringify(task)); db.close();
  const raw = f.exported([user(prompt)]);
  assert.deepEqual(readSessionHistory(f.root, { sessionId, exported: raw }), raw);
});
