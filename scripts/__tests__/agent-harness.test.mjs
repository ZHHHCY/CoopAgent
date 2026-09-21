import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceTurnBudget, createTurnBudget, pauseTurnBudget, remainingTurnBudgetMs,
  resumeTurnBudget, TURN_HARD_BUDGET_MS, gateTurnTool } from '../lib/agent-harness.mjs';

const step = (state, n, now = 0) => advanceTurnBudget(state,
  { now, kind: 'tool-step', eventId: `message-${n}` });

test('turn budget closes, finalizes and stops by model tool-execution step without counting duplicate calls', () => {
  let state = createTurnBudget(0);
  for (let i = 1; i < 12; i++) assert.equal((state = step(state, i).state).stage, 'work');
  let result = step(state, 11); state = result.state;
  assert.equal(result.toolSteps, 11, 'two calls from one model message count once');
  result = step(state, 12); state = result.state;
  assert.equal(result.stage, 'closing');
  result = advanceTurnBudget(state, { now: 0, kind: 'before-model', consumePrompt: true }); state = result.state;
  assert.match(result.instruction, /探索已进入长尾/);
  assert.equal(advanceTurnBudget(state, { now: 0, kind: 'before-model', consumePrompt: true }).instruction, null);
  for (let i = 13; i <= 18; i++) state = step(state, i).state;
  assert.equal(state.stage, 'final');
  result = advanceTurnBudget(state, { now: 0, kind: 'before-model', consumePrompt: true }); state = result.state;
  assert.match(result.instruction, /最终收尾/);
  state = step(state, 19).state; result = step(state, 20);
  assert.equal(result.action, 'stop'); assert.equal(result.stage, 'stopped');
});

test('time budgets persist from the original turn start and a selected result requests early close', () => {
  let result = advanceTurnBudget(createTurnBudget(1_000), { now: 181_000, kind: 'tool-end' });
  assert.equal(result.stage, 'closing');
  result = advanceTurnBudget(result.state, { now: 271_000, kind: 'tool-end' });
  assert.equal(result.stage, 'final');
  result = advanceTurnBudget(result.state, { now: 1_000 + TURN_HARD_BUDGET_MS, kind: 'tool-end' });
  assert.equal(result.action, 'stop');
  result = advanceTurnBudget(createTurnBudget(0), { now: 1, kind: 'state', closeSignal: 'deliverable-result' });
  assert.equal(result.stage, 'closing'); assert.equal(result.reason, 'deliverable-result');
  result = advanceTurnBudget(result.state, { now: 90_001, kind: 'tool-end' });
  assert.equal(result.stage, 'final', 'an early result gets one 90-second extension, not the unused work budget');
  result = advanceTurnBudget(result.state, { now: 150_001, kind: 'tool-end' });
  assert.equal(result.action, 'stop');
});

test('paused user time is excluded while spent active time and steps survive resume', () => {
  let state = advanceTurnBudget(createTurnBudget(1_000), { now: 101_000, kind: 'tool-end' }).state;
  state = pauseTurnBudget(state, 101_000);
  assert.equal(state.activeElapsedMs, 100_000);
  state = resumeTurnBudget(state, 701_000);
  let result = advanceTurnBudget(state, { now: 701_001, kind: 'tool-step', eventId: 'after-answer' });
  assert.equal(result.elapsedMs, 100_001);
  assert.equal(result.toolSteps, 1);
  assert.equal(remainingTurnBudgetMs(result.state), TURN_HARD_BUDGET_MS - 100_001);
});

test('closing permits a bounded evidence chain while final redirects new exploration', () => {
  let state=createTurnBudget(0,{workSteps:1});
  state=step(state,1).state;
  let gate=gateTurnTool(state,{tool:'coop_search',callId:'lookup-1'});
  assert.equal(gate.action,'dispatch'); state=gate.state;
  assert.equal(gateTurnTool(state,{tool:'coop_search',callId:'lookup-1'}).action,'dispatch','replay is idempotent');
  assert.equal(gateTurnTool(state,{tool:'coop_search_batch',callId:'lookup-2'}).action,'dispatch',
    'the closing extension itself bounds the evidence chain');
  assert.equal(gateTurnTool(state,{tool:'coop_plan_submit',callId:'submit'}).action,'dispatch');
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-2'}).state;
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-3'}).state;
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-4'}).state;
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-5'}).state;
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-6'}).state;
  state=advanceTurnBudget(state,{now:0,kind:'tool-step',eventId:'message-7'}).state;
  assert.equal(state.stage,'final');
  assert.equal(gateTurnTool(state,{tool:'coop_search',callId:'lookup-final'}).action,'closeout');
});
