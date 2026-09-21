import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentTaskStore, PHASE_BUDGET_MS, MAX_AUTO_PHASES, taskContextFromEnvironment, phasePrompt } from '../lib/agent-task.mjs';

function fixture(t, budgetMs = 300_000, harnessEnabled = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'coop-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = 1_000;
  const options = { now: () => clock, budgetMs, harnessEnabled };
  const store = createAgentTaskStore(root, options);
  const input = { id: 'task-one', runId: 'run-one', prompt: '只修改指挥官，不启动游戏' };
  store.begin(input);
  const open = () => { const result = store.open(input); return { ...input, phase: result.task.phase }; };
  return { root, options, input, store, open, advance: (ms = 300_000) => clock += ms };
}

test('legacy feature flag keeps an unlimited phase and still supports cancellation', t => {
  assert.equal(PHASE_BUDGET_MS, 330_000);
  const f = fixture(t, null, false); const ctx = f.open();
  assert.equal(f.store.get({ id: ctx.id }).experiment.variant, 'same-delivery-policy-unlimited');
  assert.equal(f.store.guard(ctx).deadline, null);
  f.advance(3_600_000 * 12);
  const store = createAgentTaskStore(f.root, { now: f.options.now, harnessEnabled: false });
  assert.equal(store.guard(ctx).status, 'running');
  store.observe({ ...ctx, input: { operation: 'entity.get' }, output: { value: 1 } });
  assert.equal(store.working(ctx).remainingSeconds, null);
  assert.equal(store.working(ctx).evidence.length, 1);
  assert.match(phasePrompt(store.get(ctx), {}), /没有阶段时间限制/);
  const draftPath = 'game-a/drafts/unlimited.patch-plan.json';
  mkdirSync(path.dirname(path.join(f.root, draftPath)), { recursive: true });
  store.draft({ ...ctx, draftPath }, () => writeFileSync(path.join(f.root, draftPath), '{}'));
  assert.equal(store.finish({ ...ctx, reason: 'cancelled' }).status, 'cancelled');
  assert.throws(() => store.guard(ctx), /ended/);
  store.begin({ id: 'unused', runId: 'run-two', prompt: '继续', resumeId: ctx.id });
  assert.equal(store.open({ id: ctx.id, runId: 'run-two' }).task.deadline, null);
  assert.throws(() => store.guard(ctx), /Stale/);
});
const point = { stage: 'scope', summary: '已确认两个武器，尚未修改', facts: ['来自数据库的实际对象'],
  remaining: ['私有生产入口未确认'], nextAction: '查询生产入口', disposition: 'continue' };

const clarification = { question: '你要改的是10级升级的建造加速吗？', target: '泽拉图10级升级',
  currentEffect: '建造加速50%', proposedEffect: '建造加速25%', reason: '所述名称与等级对应名称不同' };

test('target clarification persists, fences tools, and resumes with user correction and saved evidence', t => {
  const f = fixture(t); const ctx = f.open();
  const key = f.store.observe({ ...ctx, input: { operation: 'commander.get', commanderId: 'Zeratul' }, output: { level: 10 } });
  const result = f.store.requestConfirmation({ ...ctx, ...clarification, evidenceKeys: [key] });
  assert.equal(result.status, 'awaiting-confirmation');
  const reopened = createAgentTaskStore(f.root, f.options);
  assert.equal(reopened.get(ctx).confirmation.question, clarification.question);
  assert.throws(() => reopened.guard(ctx), /ended/);
  assert.throws(() => reopened.open(ctx), /cannot start/);
  let committed = false;
  assert.throws(() => reopened.draft({ ...ctx, draftPath: 'game-a/drafts/test.patch-plan.json' }, () => committed = true), /ended/);
  assert.throws(() => reopened.select({ ...ctx, preparationId: 'x' }, () => committed = true), /ended/);
  assert.equal(committed, false);
  assert.equal(reopened.observe({ ...ctx, input: {}, output: {} }), undefined);
  assert.equal(reopened.finish({ ...ctx, reason: 'error', sessionId: 'ses_kept' }).status, 'awaiting_confirmation');
  assert.throws(() => reopened.begin({ ...f.input, resumeId: ctx.id }), /请先回答/);
  assert.equal(reopened.get(ctx).status, 'awaiting_confirmation');
  const answer = '不是建造加速，我要改10级升级里的训练加速。';
  reopened.begin({ ...f.input, runId: 'run-two', resumeId: ctx.id, answer });
  const resumed = reopened.open({ id: ctx.id, runId: 'run-two' });
  assert.equal(resumed.task.phase, 2);
  assert.equal(resumed.task.modelSessionId, 'ses_kept');
  assert.equal(resumed.task.confirmation, null);
  assert.equal(resumed.task.prompt, f.input.prompt);
  assert.equal(resumed.task.clarifications[0].answer, answer);
  assert(resumed.prompt.includes(answer));
  assert(resumed.prompt.includes(clarification.currentEffect));
  assert.equal(resumed.context.evidence[0].key, key);
  assert.throws(() => reopened.guard(ctx), /Stale/);
});

test('ten minutes waiting for confirmation does not spend the remaining active turn budget', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  assert.equal(f.store.get({ id: ctx.id }).experiment.variant, 'same-delivery-policy-budgeted');
  assert.match(f.store.get({ id: ctx.id }).experiment.configurationHash, /^[a-f0-9]{64}$/);
  f.store.harnessControl({ ...ctx, kind: 'tool-step', eventId: 'before-confirmation' });
  f.advance(100_000);
  f.store.requestConfirmation({ ...ctx, ...clarification });
  const paused = f.store.get({ id: ctx.id });
  assert.equal(paused.turns[0].budget.activeElapsedMs, 100_000);
  assert.equal(paused.turns[0].budget.toolSteps, 1);
  f.advance(600_000);
  f.store.begin({ id: ctx.id, runId: 'run-two', prompt: '确认后继续', resumeId: ctx.id, answer: '是，继续。' });
  const resumed = f.store.open({ id: ctx.id, runId: 'run-two' }).task;
  assert.equal(resumed.deadline - resumed.startedAt, 230_000);
  assert.equal(resumed.turns[0].budget.activeElapsedMs, 100_000);
  assert.equal(resumed.turns[0].budget.toolSteps, 1);
  assert.equal(f.store.guard({ id: ctx.id, runId: 'run-two', phase: 2 }).status, 'running');
  assert.throws(() => f.store.guard(ctx), /Stale/);
});

test('bounded submission observation pauses active time but keeps a hard tool deadline', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  f.advance(5_000);
  const waiting = f.store.harnessControl({ ...ctx, kind: 'wait-start' });
  assert.equal(waiting.elapsedMs, 5_000); assert.equal(waiting.waiting, true);
  let task = f.store.get({ id: ctx.id });
  assert.equal(task.deadline - task.updatedAt, 325_000 + 240_000);
  f.advance(180_000);
  const resumed = f.store.harnessControl({ ...ctx, kind: 'wait-end' });
  assert.equal(resumed.elapsedMs, 5_000); assert.equal(resumed.waiting, false);
  task = f.store.get({ id: ctx.id });
  assert.equal(task.deadline - task.updatedAt, 325_000);
  assert.equal(f.store.guard(ctx).status, 'running');
});

test('clarification rejects missing evidence, survives a rejected draft, and cannot replace a selected submission', t => {
  const f = fixture(t); const ctx = f.open();
  assert.throws(() => f.store.requestConfirmation({ ...ctx, ...clarification, evidenceKeys: ['unknown'] }), /Unknown/);
  assert.throws(() => f.store.requestConfirmation({ ...ctx, ...clarification, question: '' }), /concise/);
  const draftPath = 'game-a/drafts/test.patch-plan.json';
  mkdirSync(path.dirname(path.join(f.root, draftPath)), { recursive: true });
  f.store.draft({ ...ctx, draftPath }, () => writeFileSync(path.join(f.root, draftPath), '{}'));
  const result = f.store.requestConfirmation({ ...ctx, ...clarification });
  assert.equal(result.status, 'awaiting-confirmation');

  const selected = fixture(t); const selectedContext = selected.open();
  selected.store.select({ ...selectedContext, preparationId: 'prep-selected' });
  assert.throws(() => selected.store.requestConfirmation({ ...selectedContext, ...clarification }), /before submitting/);
  assert.equal(selected.store.guard(selectedContext).status, 'running');
});



test('host supplies task context and budget without imposing the scalar workflow on every request', () => {
  const prompt = phasePrompt({ prompt: '查询生命值', currentInput: '现在改为100', phase: 1 }, { evidence: ['已有证据'] });
  assert.match(prompt, /用户原始请求：\n查询生命值/);
  assert.match(prompt, /本轮用户输入：\n现在改为100/);
  assert.match(prompt, /已有证据/);
  assert.match(prompt, /工具执行轮和总耗时/);
  assert.match(prompt, /按当前 Agent 配置选择处理方式/);
  assert.doesNotMatch(prompt, /coop-scalar-change|coop-query|原子计划|PatchPlan|scalar_solve|plan_prepare/);
});

test('delivery persists across phases; invalid resolution cannot write and immutable selection is checked', t => {
  const f = fixture(t); const ctx = f.open();
  const draftPath = 'game-a/drafts/delivery.patch-plan.json';
  const file = path.join(f.root, draftPath); mkdirSync(path.dirname(file), { recursive: true });
  const plan = { id: 'delivery', operations: [1, 2].map(n => ({ opId: `op-${n}`, kind: 'catalog.set', catalog: 'Unit', object: 'U', path: `Field${n}`, value: n })) };
  f.store.draft({ ...ctx, draftPath, plan }, () => writeFileSync(file, JSON.stringify(plan)));
  let written = false;
  assert.throws(() => f.store.draft({ ...ctx, draftPath, plan, resolutions: [{ id: 'bogus' }] }, () => written = true), /Unknown delivery/);
  assert.equal(written, false);
  f.store.checkpoint({ ...ctx, ...point }); f.store.finish({ ...ctx, reason: 'completed' });
  const next = f.open();
  const smaller = { ...plan, operations: plan.operations.slice(0, 1) };
  f.store.draft({ ...next, draftPath, plan: smaller }, () => writeFileSync(file, JSON.stringify(smaller)));
  assert.equal(f.store.working(next).delivery.openCount, 1);
  // The snapshot wins over the mutable current draft, which still has one op.
  assert.equal(f.store.select({ ...next, preparationId: 'complete', plan }).selectedPreparation, 'complete');
  assert.equal(f.store.working(next).delivery.openCount, 0);
  assert.throws(() => f.store.select({ ...next, preparationId: 'other', plan: smaller }), /already selected/);
});

test('archived tool pages are exact, task-scoped, durable and not counted as research progress', t => {
  const f = fixture(t); const ctx = f.open();
  const part = { tool: 'search', state: { input: { query: '中文' }, output: '事实'.repeat(18000) } };
  const [key] = f.store.archiveContext({ id: ctx.id, parts: [part] });
  const store = createAgentTaskStore(f.root, f.options);
  let restored = '', offset = 0;
  do { const page = store.readContext({ id: ctx.id, key, offset, limit: 6000 }); restored += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(JSON.parse(restored), part);
  assert.throws(() => store.readContext({ id: ctx.id, key, limit: 12001 }), /Invalid context/);
  store.begin({ id: 'other', runId: 'other', prompt: 'Other request' });
  assert.throws(() => store.readContext({ id: 'other', key }), /Unknown task context/);
  assert.equal(store.working(ctx).originalRequest, f.input.prompt);
  assert.equal(store.working(ctx).remainingSeconds, 300);
  f.advance(); const ended = store.finish({ ...ctx, reason: 'budget' });
  assert.equal(ended.progress.newEvidence, 0); assert.equal(ended.status, 'blocked');
});

test('a task created before the ledger migration retains its previously saved operations', t => {
  const f = fixture(t); const ctx = f.open();
  const draftPath = 'game-a/drafts/legacy.patch-plan.json'; const file = path.join(f.root, draftPath);
  mkdirSync(path.dirname(file), { recursive: true });
  const plan = { id: 'legacy', operations: [1, 2].map(n => ({ opId: `op-${n}`, kind: 'locale.set', locale: 'zhCN', key: `Name${n}`, value: 'New' })) };
  f.store.draft({ ...ctx, draftPath }, () => writeFileSync(file, JSON.stringify(plan)));
  const smaller = { ...plan, operations: plan.operations.slice(0, 1) };
  f.store.draft({ ...ctx, draftPath, plan: smaller }, () => writeFileSync(file, JSON.stringify(smaller)));
  assert.equal(f.store.working(ctx).delivery.openCount, 1);
  assert.equal(f.store.select({ ...ctx, preparationId: 'smaller', plan: smaller }).selectedDelivery.openCount, 1);
  const restarted = createAgentTaskStore(f.root, f.options);
  assert.equal(restarted.working(ctx).delivery.policy, 'advisory');
  assert.equal(restarted.working(ctx).delivery.openCount, 1);
});

test('first candidate can select with unresolved compatibility while persisting exact reminders', t => {
  const f = fixture(t); const ctx = f.open();
  const draftPath = 'game-a/drafts/clone.patch-plan.json';
  const file = path.join(f.root, draftPath); mkdirSync(path.dirname(file), { recursive: true });
  const plan = { id: 'clone', operations: [{ opId: 'clone', kind: 'catalog.clone', catalog: 'Weapon', source: 'Old', object: 'New' }] };
  f.store.draft({ ...ctx, draftPath, plan }, () => writeFileSync(file, JSON.stringify(plan)));
  let committed = false;
  const selected = f.store.select({ ...ctx, preparationId: 'candidate', plan }, () => committed = true);
  assert.equal(committed, true);
  assert.equal(selected.selectedDelivery.openCount, 1);
  assert.equal(selected.selectedDelivery.items[1].status, 'open');
  writeFileSync(file, JSON.stringify({ ...plan, operations: [] }));
  assert.deepEqual(createAgentTaskStore(f.root, f.options).working(ctx).delivery, selected.selectedDelivery);
  assert.equal(f.store.finish({ ...ctx, reason: 'completed' }).status, 'submitted');
});

test('five-minute phase checkpoints persist and block further calls without writing Game A', (t) => {
  const f = fixture(t); const ctx = f.open();
  assert.equal(f.store.guard(ctx).deadline - 1000, 300_000);
  f.store.checkpoint({ ...ctx, ...point });
  assert.throws(() => f.store.guard(ctx), /ended/);
  assert.equal(f.store.finish({ ...ctx, reason: 'completed' }).status, 'ready');
  const fresh = createAgentTaskStore(f.root, f.options).open(f.input);
  assert.equal(fresh.context.checkpoint.summary, point.summary);
  assert.equal(fresh.task.phase, 2);
  assert.ok(!existsSync(path.join(f.root, 'game-a/core')));
  assert.throws(() => f.store.guard(ctx), /Stale/);
});

test('budget fallback preserves exact query output and cannot be called application success', (t) => {
  const f = fixture(t); const ctx = f.open();
  const input = { operation: 'entity.get', catalog: 'Weapon', objectId: 'Example', path: 'AllowedMovement' };
  const output = { value: 'Moving', edit: { available: false } };
  f.store.observe({ ...ctx, input, output }); f.advance();
  assert.throws(() => f.store.guard(ctx), /ended/);
  const result = f.store.finish({ ...ctx, reason: 'budget' });
  assert.equal(result.status, 'ready'); assert.equal(result.lastCheckpoint.source, 'host');
  const next = f.store.open(f.input);
  assert.deepEqual(f.store.get({ id: ctx.id, key: next.context.evidence[0].key }), output);
  assert.match(next.prompt, /复用已有上下文/);
  assert.equal(result.selectedPreparation, null);
});

test('harness recovery carries confirmed values instead of inferring facts from query names',t=>{
  const f=fixture(t,330_000,true),ctx=f.open();
  const input={operation:'entity.get',catalog:'Effect',objectId:'Parameter',path:'Amount',commanderId:'TerranMengsk'};
  f.store.observe({...ctx,input,output:{database:{sc2Build:'B97579'},editState:{coreCatalog:{value:0.5}}}});
  const working=f.store.working(ctx);
  assert.match(working.confirmedFacts[0].statement,/当前值为 0\.5/);
  assert.equal(working.confirmedFacts[0].sourceRevision,'B97579');
  const ended=f.store.finish({...ctx,reason:'budget'});
  assert.match(ended.lastCheckpoint.facts[0],/当前值为 0\.5/);
  assert.doesNotMatch(ended.lastCheckpoint.facts[0],/^entity\.get:/);
});

test('no new evidence pauses instead of an unbounded spend loop', (t) => {
  const f = fixture(t); const ctx = f.open(); f.advance();
  assert.equal(f.store.finish({ ...ctx, reason: 'budget' }).status, 'blocked');
  assert.throws(() => f.open(), /cannot/);
});

test('automatic phases are bounded, and manual resume retains the original request', (t) => {
  const f = fixture(t);
  for (let i = 0; i < MAX_AUTO_PHASES; i++) {
    const ctx = f.open();
    f.store.observe({ ...ctx, input: { operation: 'entity.get', objectId: `Step${i}` }, output: { value: i } });
    f.store.checkpoint({ ...ctx, ...point }); f.store.finish({ ...ctx, reason: 'completed' });
  }
  assert.equal(f.store.get(f.input).status, 'paused');
  const resumed = f.store.begin({ id: 'new-id', runId: 'run-two', prompt: '继续', resumeId: f.input.id });
  assert.equal(resumed.prompt, f.input.prompt); assert.equal(resumed.autoPhases, 0);
  assert.equal(f.store.open({ id: resumed.id, runId: resumed.runId }).task.phase, MAX_AUTO_PHASES + 1);
});

test('same task retains its model session across phases, restart and deadline finalization', t => {
  const f = fixture(t); const ctx = f.open();
  f.store.observe({ ...ctx, input: { operation: 'entity.get', objectId: 'Ship' }, output: { value: 2 } });
  f.advance(); f.store.finish({ ...ctx, reason: 'budget' });
  const ended = f.store.finish({ ...ctx, reason: 'budget', sessionId: 'ses_continuous' });
  assert.equal(ended.history.length, 1, 'late session identity does not finish twice');
  const next = createAgentTaskStore(f.root, f.options).open(f.input);
  assert.equal(next.task.modelSessionId, 'ses_continuous');
  assert.match(next.prompt, /同一模型会话/);
  assert.throws(() => f.store.finish({ ...ctx, reason: 'completed', sessionId: 'ses_stale' }), /Stale/);
  assert.throws(() => f.store.finish({ ...ctx, reason: 'completed', sessionId: '../session' }), /Invalid model/);
});

test('re-reading evidence or claiming draft stage cannot sustain empty progress', t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const ctx = f.open();
    f.store.checkpoint({ ...ctx, ...point, stage: 'draft' });
    const result = f.store.finish({ ...ctx, reason: 'completed' });
    assert.equal(result.lastCheckpoint.stage, 'scope');
    assert.equal(result.progress.draftChanged, false);
  }
  const task = f.store.get(f.input);
  assert.equal(task.status, 'paused'); assert.match(task.pauseReason, /草稿变化/);
});

test('draft progress uses actual content, not repeated writes of the same file', t => {
  const f = fixture(t);
  const relative = 'game-a/drafts/test.patch-plan.json';
  mkdirSync(path.dirname(path.join(f.root, relative)), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const ctx = f.open();
    f.store.draft({ ...ctx, draftPath: relative }, () => writeFileSync(path.join(f.root, relative), '{"same":true}'));
    f.store.checkpoint({ ...ctx, ...point, stage: 'draft' });
    const result = f.store.finish({ ...ctx, reason: 'completed' });
    assert.equal(result.progress.draftChanged, i === 0);
  }
  assert.equal(f.store.get(f.input).status, 'paused');
});

test('final selection is one-shot and expired phases cannot submit; failed selection rolls back', (t) => {
  const f = fixture(t); const ctx = f.open();
  assert.throws(() => f.store.select({ ...ctx, preparationId: 'prep-one' }, () => { throw Error('job insert failed'); }), /job insert/);
  assert.equal(f.store.get(f.input).selectedPreparation, null);
  f.store.select({ ...ctx, preparationId: 'prep-one' });
  assert.throws(() => f.store.select({ ...ctx, preparationId: 'prep-two' }), /already selected/);
  assert.equal(f.store.finish({ ...ctx, reason: 'budget' }).status, 'submitted');
  assert.throws(() => f.store.begin({ id: 'x', runId: 'run-two', prompt: 'continue', resumeId: ctx.id }), /not resumable/);
});

test('cancelled task and an expired abandoned phase are resumable; stale writers stay fenced', (t) => {
  const f = fixture(t); const ctx = f.open();
  f.store.finish({ ...ctx, reason: 'cancelled' });
  f.store.begin({ id: 'x', runId: 'run-two', prompt: 'continue', resumeId: ctx.id });
  const next = f.store.open({ id: ctx.id, runId: 'run-two' }); f.advance();
  assert.throws(() => f.store.select({ id: ctx.id, runId: 'run-two', phase: next.task.phase, preparationId: 'prep-three' }), /ended/);
  const recovered = f.store.begin({ id: 'x', runId: 'run-three', prompt: 'continue', resumeId: ctx.id });
  assert.equal(recovered.status, 'ready');
  assert.throws(() => f.store.guard(ctx), /Stale/);
});

test('checkpoint validates bounded structured facts and the server only opts in with trusted phase identity', (t) => {
  const f = fixture(t); const ctx = f.open();
  assert.throws(() => f.store.checkpoint({ ...ctx, ...point, facts: Array(17).fill('x') }), /Invalid/);
  assert.throws(() => f.store.draft({ ...ctx, draftPath: 'game-a/core/Unit.xml' }), /Invalid/);
  assert.equal(taskContextFromEnvironment({}), null);
  assert.throws(() => taskContextFromEnvironment({ COOPAGENT_TASK_ID: 'task-one' }), /Invalid/);
  assert.deepEqual(taskContextFromEnvironment({ COOPAGENT_TASK_ID: ctx.id, COOPAGENT_RUN_ID: ctx.runId, COOPAGENT_TASK_PHASE: '1' }), { id: ctx.id, runId: ctx.runId, phase: 1 });
});

test('a validation rejection survives a budget handoff as evidence, not as an applied result', (t) => {
  const f = fixture(t); const ctx = f.open();
  const output = { status: 'error', messages: ['SCOPE_LEAK'], validationPhase: 'pre-execution' };
  f.store.observe({ ...ctx, input: { operation: 'plan_prepare', planId: 'test-plan' }, output });
  f.advance(); f.store.finish({ ...ctx, reason: 'budget' });
  const next = f.store.open(f.input);
  assert.equal(next.context.evidence[0].query.planId, 'test-plan');
  assert.deepEqual(f.store.get({ id: ctx.id, key: next.context.evidence[0].key }), output);
  assert.equal(next.task.selectedPreparation, null);
});
test('checkpoint separates hypotheses and rejects evidence from another task', (t) => {
  const f = fixture(t); const ctx = f.open();
  f.store.observe({ ...ctx, input: { operation: 'entity.get', objectId: 'Ship' }, output: { value: 100 } });
  assert.throws(() => f.store.checkpoint({ ...ctx, stage: 'scope', summary: 'facts', facts: ['100'],
    evidenceKeys: ['f'.repeat(64)], nextAction: 'write' }), /Unknown checkpoint evidence/);
  f.store.checkpoint({ ...ctx, stage: 'scope', summary: 'facts', facts: ['100'], hypotheses: ['A possible route, not proven'], nextAction: 'verify route' });
  const task = f.store.get({ id: ctx.id });
  assert.equal(task.checkpoint.hypotheses.length, 1);
  assert.deepEqual(task.checkpoint.facts, ['100']);
});

test('the final tool batch can save its delivery checkpoint before the step boundary seals the turn', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  for (let step = 1; step <= 19; step++) f.store.harnessControl({ ...ctx, kind: 'tool-step', eventId: `message-${step}` });
  const delivery = { outcome: 'no_change', completed: ['目标已经满足'], omitted: [],
    verification: { level: 'static_checked' } };
  assert.equal(f.store.checkpoint({ ...ctx, stage: 'verify', summary: '无需修改', nextAction: '等待用户反馈',
    disposition: 'deliver', delivery }).status, 'delivery-saved');
  const terminal = f.store.harnessControl({ ...ctx, kind: 'tool-step', eventId: 'message-20' });
  assert.equal(terminal.action, 'stop'); assert.equal(terminal.toolSteps, 20);
  const task = f.store.get({ id: ctx.id });
  assert.equal(task.deliveryOutcome, 'no_change'); assert.equal(task.turns[0].budget.toolSteps, 20);
  assert.throws(() => f.store.guard(ctx), /ended/);
});

test('delivery preserves the actual answer separately from internal facts before stopping', t => {
  for (const reply of ['我是 CoopAgent，可以帮你查询和修改合作模式的指挥官数值。',
    '生命已从 45 改为 60。尚未进行游戏验证。\n' + '其他已核对的字段保持原值。'.repeat(30)]) {
    const f = fixture(t, 330_000, true), ctx = f.open();
    const result = f.store.checkpoint({ ...ctx, stage: 'verify', summary: reply, facts: ['内部观察记录'],
      nextAction: '等待反馈', disposition: 'deliver',
      delivery: { outcome: 'complete', completed: ['已回答'], omitted: [], verification: { level: 'not_checked' } } });
    assert.equal(result.task.checkpoint.summary, reply);
    assert.match(result.instruction, /display summary/);
    assert.throws(() => f.store.guard(ctx), /ended/);
    f.store.finish({ ...ctx, reason: 'completed' });
    const reopened = createAgentTaskStore(f.root, f.options).get(ctx);
    assert.equal(reopened.lastCheckpoint.summary, reply);
    assert.deepEqual(reopened.lastCheckpoint.facts, ['内部观察记录']);
  }
});

test('the hard boundary lets already-issued sibling tools finish before the next model step seals writes', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  f.store.observe({...ctx,input:{operation:'entity.get',catalog:'Unit',objectId:'Target',path:'LifeMax'},
    output:{database:{sc2Build:'B97579'},editState:{coreCatalog:{value:125}}}});
  for (let step = 1; step <= 20; step++) {
    const result = f.store.harnessControl({ ...ctx, kind: 'tool-step', eventId: `message-${step}` });
    if (step === 20) assert.equal(result.action, 'stop');
  }
  assert.equal(f.store.guard(ctx).status, 'running', 'the rest of the terminal tool batch remains writable');
  assert.equal(f.store.harnessControl({ ...ctx, kind: 'state' }).action, 'stop');
  assert.equal(f.store.guard(ctx).status, 'running', 'a sibling tool entry is not a new model step');
  assert.equal(f.store.harnessControl({ ...ctx, kind: 'before-model' }).action, 'stop');
  const sealed=f.store.get({id:ctx.id});
  assert.match(sealed.lastCheckpoint.facts[0],/当前值为 125/);
  assert.match(sealed.lastCheckpoint.remaining[0],/not_submitted/);
  assert.throws(() => f.store.guard(ctx), /ended/);
});

test('an applied receipt remains a useful partial delivery when the hard stop preempts model summary', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  f.store.select({ ...ctx, preparationId: 'prep-terminal' });
  const jobsFile = path.join(f.root, 'game-a/runtime/plan-jobs.sqlite');
  const jobs = new DatabaseSync(jobsFile);
  jobs.exec('CREATE TABLE jobs(preparation_id TEXT PRIMARY KEY,run_id TEXT,state TEXT,result TEXT,error TEXT,updated_at TEXT)');
  jobs.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run('prep-terminal', 'run-one', 'applied',
    JSON.stringify({ report: { receiptRecord: 'game-a/receipts/terminal.json', receipt: { planId: 'terminal-plan' } } }), null, 'now');
  jobs.close();
  for (let step = 1; step <= 20; step++) f.store.harnessControl({ ...ctx, kind: 'tool-step', eventId: `message-${step}` });
  f.store.harnessControl({ ...ctx, kind: 'before-model' });
  const ended = f.store.finish({ ...ctx, reason: 'completed' });
  assert.equal(ended.applicationStatus, 'applied');
  assert.equal(ended.deliveryOutcome, 'partial');
  assert.match(ended.turns[0].delivery.model.completed[0], /terminal-plan/);
  assert.equal(ended.turns[0].delivery.model.verification.runtimeVerified, false);
});

test('submission observation is distinct from an applied useful result and from failure', t => {
  const f = fixture(t, 330_000, true); const ctx = f.open();
  f.store.select({ ...ctx, preparationId: 'prep-state' });
  let control = f.store.harnessControl({ ...ctx, kind: 'tool-end' });
  assert.equal(control.applicationStatus, 'submitted'); assert.equal(control.usefulResult, false);
  assert.equal(control.reason, 'submission-observation');
  const jobsFile = path.join(f.root, 'game-a/runtime/plan-jobs.sqlite');
  const jobs = new DatabaseSync(jobsFile);
  jobs.exec('CREATE TABLE jobs(preparation_id TEXT PRIMARY KEY,run_id TEXT,state TEXT,result TEXT,error TEXT,updated_at TEXT)');
  jobs.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run('prep-state', 'run-one', 'failed', null,
    JSON.stringify({ message: 'synthetic failure' }), 'now');
  jobs.close();
  control = f.store.harnessControl({ ...ctx, kind: 'tool-end' });
  assert.equal(control.applicationStatus, 'failed'); assert.equal(control.usefulResult, false);
  assert.equal(f.store.get({ id: ctx.id }).turns[0].submission.observation, 'failed');
});

test('iterative harness ends one delivery turn, preserves backend application facts, and opens feedback as a new turn', t => {
  const f = fixture(t, 330_000, true); const first = f.open();
  f.store.select({ ...first, preparationId: 'prep-first' });
  const jobsFile = path.join(f.root, 'game-a/runtime/plan-jobs.sqlite');
  const jobs = new DatabaseSync(jobsFile);
  jobs.exec('CREATE TABLE jobs(preparation_id TEXT PRIMARY KEY,run_id TEXT,state TEXT,result TEXT,error TEXT,updated_at TEXT)');
  jobs.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run('prep-first', 'run-one', 'applied',
    JSON.stringify({ report: { receiptRecord: 'game-a/receipts/first.json', receipt: { planId: 'first' } } }), null, 'now');
  jobs.close();
  const appliedControl = f.store.harnessControl({ ...first, kind: 'tool-end' });
  assert.equal(appliedControl.applicationStatus, 'applied'); assert.equal(appliedControl.usefulResult, true);
  const delivery = { outcome: 'partial', completed: ['玩法数值已改为 0.7'], omitted: ['面板仍显示旧值'],
    verification: { level: 'static_checked', notes: '尚未试玩' } };
  assert.equal(f.store.checkpoint({ ...first, stage: 'verify', summary: '玩法已修改，面板未同步', facts: ['Receipt 由后端核对'],
    remaining: ['面板文案'], nextAction: '等待用户反馈后补面板', disposition: 'deliver', delivery }).status, 'delivery-saved');
  const ended = f.store.finish({ ...first, reason: 'completed', assistantText: '玩法已改，面板尚未同步。' });
  assert.equal(ended.status, 'ended'); assert.equal(ended.deliveryOutcome, 'partial');
  assert.equal(ended.turns[0].delivery.application.status, 'applied');
  assert.equal(ended.turns[0].delivery.application.receiptPath, 'game-a/receipts/first.json');

  const resumed = f.store.begin({ id: 'ignored', runId: 'run-two', prompt: '把面板也补上', resumeId: ended.id });
  assert.equal(resumed.turns.length, 2); assert.equal(resumed.currentInput, '把面板也补上');
  assert.equal(resumed.turns[0].selectedPreparation, 'prep-first');
  assert.equal(resumed.selectedPreparation, null);
  const second = f.store.open({ id: ended.id, runId: 'run-two' });
  assert.equal(second.context.priorTurns[0].delivery.application.status, 'applied');
  assert.equal(second.context.requestItems.length, 2);
  assert.throws(() => f.store.select({ ...first, preparationId: 'stale' }), /Stale/);
});
