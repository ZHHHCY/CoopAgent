import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentHarnessAdapter } from '../lib/agent-harness-adapter.mjs';

test('adapter injects the persisted close prompt in place and emits a host control event', async () => {
  const calls = []; const lines = []; let injected = false;
  const store = { harnessControl(input) {
    calls.push(input);
    return input.kind === 'before-model'
      ? { action: 'close', stage: 'closing', elapsedMs: 1, toolSteps: 12, reason: 'work-steps', instruction: injected ? null : (injected = true, 'CLOSE NOW') }
      : { action: 'continue', stage: 'work', elapsedMs: 0, toolSteps: 1, reason: null, instruction: null };
  } };
  const env = { COOPAGENT_TASK_ID: 'task-one', COOPAGENT_RUN_ID: 'run-one', COOPAGENT_TASK_PHASE: '1' };
  let tick = 0;
  const hooks = createAgentHarnessAdapter({ env, store, write: line => lines.push(line), monotonicNow: () => tick });
  await hooks['chat.message']({ agent: 'coop-planner', sessionID: 'ses-main' });
  const output = { system: ['base'] };
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses-main' }, output);
  assert.deepEqual(output.system, ['base', 'CLOSE NOW']);
  await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', sessionID: 'ses-main', messageID: 'msg-1', state: { status: 'running' } } } } });
  assert.equal(calls.length, 1, 'a running tool cannot spend the batch before its checkpoint can finish');
  tick = 10;
  await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', sessionID: 'ses-main', messageID: 'msg-1', state: { status: 'completed' } } } } });
  assert.equal(calls.at(-1).kind, 'tool-step');
  assert.equal(calls.at(-1).eventId, 'ses-main:msg-1');
  assert.equal(calls.at(-1).activeDeltaMs, 10);
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses-background' }, output);
  assert.equal(calls.length, 2, 'background sessions do not consume this turn budget');
  assert.match(lines.join(''), /harness_control/);
});

test('adapter excludes submission backend wait without changing the model budget', async () => {
  const submissionTool = 'coop_plan_submit';
  const calls = []; let tick = 0;
  const store = { harnessControl(input) {
    calls.push(input);
    return { action: 'continue', stage: 'work', elapsedMs: 0, toolSteps: 0,
      instruction: null, remainingMs: 1_000, waiting: input.kind === 'wait-start' };
  } };
  const env = { COOPAGENT_TASK_ID: 'task-one', COOPAGENT_RUN_ID: 'run-one', COOPAGENT_TASK_PHASE: '1' };
  const hooks = createAgentHarnessAdapter({ env, store, write: () => {}, monotonicNow: () => tick });
  await hooks['chat.message']({ agent: 'coop-planner', sessionID: 'ses-main' });
  tick = 25;
  await hooks['tool.execute.before']({ sessionID: 'ses-main', callID: 'call-submit', tool: submissionTool });
  assert.deepEqual(calls.slice(-2).map(call => [call.kind, call.activeDeltaMs]), [
    ['state', 25], ['wait-start', 0],
  ]);
  tick = 10_025;
  await hooks['tool.execute.after']({ sessionID: 'ses-main', callID: 'call-submit', tool: submissionTool });
  assert.equal(calls.at(-2).kind, 'wait-end');
  assert.equal(calls.at(-2).activeDeltaMs, undefined);
  assert.equal(calls.at(-1).kind, 'tool-end');
  assert.equal(calls.at(-1).activeDeltaMs, 0);
  tick = 10_040;
  await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'step-finish', sessionID: 'ses-main', messageID: 'msg-1' } } } });
  assert.equal(calls.at(-1).kind, 'state');
  assert.equal(calls.at(-1).activeDeltaMs, 15);
});

test('a spent terminal tool batch requests stop only at the following model boundary', async () => {
  const calls = [], lines = [];
  const store = { harnessControl(input) {
    calls.push(input);
    return { action: 'stop', stage: 'stopped', elapsedMs: 10, toolSteps: 20,
      reason: 'final-steps', instruction: null, remainingMs: 0, waiting: false };
  } };
  const env = { COOPAGENT_TASK_ID: 'task-one', COOPAGENT_RUN_ID: 'run-one', COOPAGENT_TASK_PHASE: '1' };
  const hooks = createAgentHarnessAdapter({ env, store, write: line => lines.push(JSON.parse(line.slice('COOPAGENT_OBSERVATION '.length))),
    monotonicNow: () => 10 });
  await hooks['chat.message']({ agent: 'coop-planner', sessionID: 'ses-main' });
  await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', sessionID: 'ses-main', messageID: 'msg-final', state: { status: 'completed' } } } } });
  assert.equal(lines.at(-1).action, 'close');
  await hooks['tool.execute.after']({ sessionID: 'ses-main', callID: 'call-final', tool: 'coop_task_checkpoint' });
  assert.equal(lines.at(-1).action, 'close');
  await hooks['experimental.chat.system.transform']({ sessionID: 'ses-main' }, { system: [] });
  assert.equal(lines.at(-1).action, 'stop');
  assert.equal(calls.at(-1).kind, 'before-model');
});

test('adapter replaces a final-stage broad search before it can dispatch', async () => {
  const calls=[];
  const store={harnessControl(input){calls.push(input);return input.kind==='tool-gate'
    ? {action:'closeout',stage:'final',reason:'final-exploration-blocked',message:'close now',
      allowedNextActions:['task_checkpoint'],checkpointRequired:true}
    : {action:'close',stage:'final',instruction:null,remainingMs:10};}};
  const env={COOPAGENT_TASK_ID:'task-one',COOPAGENT_RUN_ID:'run-one',COOPAGENT_TASK_PHASE:'1'};
  const hooks=createAgentHarnessAdapter({env,store,write:()=>{},monotonicNow:()=>0});
  await hooks['chat.message']({agent:'coop-planner',sessionID:'ses-main'});
  const output={args:{operation:'entity.resolve',catalog:'Unit',query:'wide lookup'}};
  await hooks['tool.execute.before']({sessionID:'ses-main',callID:'call-wide',tool:'coop_search'},output);
  assert.deepEqual(Object.keys(output.args),['harnessCloseout']);
  assert.equal(output.args.harnessCloseout.reason,'final-exploration-blocked');
  assert.equal(calls.some(call=>call.kind==='tool-gate'&&call.callId==='call-wide'),true);
});
