import { applicationRoot } from '../../../scripts/lib/project-context.mjs';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { taskContextFromEnvironment } from '../../../scripts/lib/task-context.mjs';
import { OBSERVATION_PREFIX } from './agent-observer.mjs';

function createCommandController(repoRoot) {
  let child = null, stdout = '', stderr = '', nextId = 0;
  const pending = new Map();
  const fail = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear(); child = null; stdout = '';
  };
  const start = () => {
    if (child) return child;
    // OpenCode loads local plugins in Bun. Keep node:sqlite in one dedicated
    // Node process instead of importing agent-task.mjs into the plugin.
    const process = spawn('node', [path.join(applicationRoot(repoRoot), 'scripts/harness-control.mjs'), repoRoot], {
      cwd: repoRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = process;
    process.stdout.on('data', chunk => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const newline = stdout.indexOf('\n'), line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); }
        catch { fail(Error(`Agent harness controller returned invalid JSON: ${line.slice(0, 500)}`)); return; }
        const request = pending.get(response.id); if (!request) continue;
        pending.delete(response.id);
        if (response.error) request.reject(Error(response.error.message)); else request.resolve(response.result);
      }
    });
    process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    process.on('error', fail);
    process.on('close', code => fail(Error(stderr.trim() || `Agent harness controller exited ${code}`)));
    process.unref(); process.stdout.unref?.(); process.stderr.unref?.();
    return process;
  };
  return input => new Promise((resolve, reject) => {
    const id = String(++nextId); pending.set(id, { resolve, reject });
    const process = start();
    process.stdin.write(`${JSON.stringify({ id, input })}\n`, error => {
      if (error && pending.delete(id)) reject(error);
    });
  });
}

// OpenCode 1.18.8 exposes prompt transformation and tool-boundary hooks, but
// no public callback that can synchronously stop its internal loop. This thin
// adapter injects close guidance in place and asks the owning host to perform
// the fenced stop when the persisted controller returns `stop`.
export function createAgentHarnessAdapter({ repoRoot = process.cwd(), env = process.env,
  write = line => writeSync(2, line), store = null, monotonicNow = () => performance.now() } = {}) {
  const context = taskContextFromEnvironment(env);
  if (env.COOPAGENT_ITERATIVE_HARNESS === '0' || !context) return {};
  const commandControl = store ? null : createCommandController(repoRoot);
  const control = input => store ? Promise.resolve(store.harnessControl(input)) : commandControl(input);
  let primarySession = null; let lastActiveTick = monotonicNow();
  const emit = event => {
    try { write(OBSERVATION_PREFIX + JSON.stringify({ type: 'harness_control', runId: context.runId,
      observedAtMs: Date.now(), ...event }) + '\n'); } catch { /* host control remains durable in the task store */ }
  };
  emit({ type: 'harness_ready', version: 1, action: 'continue', stage: 'work',
    instructionInjected: false, boundary: 'adapter-load' });
  const boundary = async (kind, { eventId = null, consumePrompt = false, sessionID = null } = {}) => {
    const tick = monotonicNow();
    const activeDeltaMs = kind === 'wait-end' ? undefined : Math.max(0, tick - lastActiveTick);
    lastActiveTick = tick;
    let result;
    try { result = await control({ ...context, kind, eventId, consumePrompt, activeDeltaMs }); }
    catch (error) {
      emit({ action: 'continue', stage: 'controller-error', reason: error.message,
        instructionInjected: false, boundary: kind, eventId, sessionID });
      return { action: 'continue', stage: 'controller-error', instruction: null, reason: error.message };
    }
    // A spent step is fenced only after its entire tool batch finishes. Until
    // the next model boundary, report close rather than asking Rust to kill an
    // in-flight sibling tool or the checkpoint that consumed the last step.
    const action = result.action === 'stop' && kind !== 'before-model' ? 'close' : result.action;
    if (action !== 'continue' || result.instruction || ['tool-step', 'wait-start', 'wait-end'].includes(kind)) emit({ ...result,
      action, instruction: undefined, instructionInjected: Boolean(result.instruction), boundary: kind,
      eventId, sessionID });
    return result;
  };
  const belongs = sessionID => !primarySession || !sessionID || sessionID === primarySession;
  return {
    'chat.message': async input => {
      if (input.agent === 'coop-planner' || !primarySession) primarySession = input.sessionID;
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!belongs(input.sessionID)) return;
      const result = await boundary('before-model', { consumePrompt: true, sessionID: input.sessionID });
      if (result.instruction) output.system.push(result.instruction);
    },
    'tool.execute.before': async (input, output = {}) => {
      if (!belongs(input.sessionID)) return;
      // Account for model work with the process-local monotonic clock before
      // entering a tool. Task-store wall time is only a crash fallback; it must
      // not silently turn machine sleep into model-active time.
      await boundary('state', { sessionID: input.sessionID });
      const exploratory = ['search', 'search_batch', 'coop_search', 'coop_search_batch'].includes(input.tool);
      const gate = exploratory ? await control({ ...context, kind: 'tool-gate', tool: input.tool,
        callId: input.callID, activeDeltaMs: 0 }) : { action: 'dispatch' };
      if (gate.action === 'closeout') {
        output.args ??= {};
        for (const key of Object.keys(output.args)) delete output.args[key];
        output.args.harnessCloseout = { stage: gate.stage, reason: gate.reason,
          message: gate.message, allowedNextActions: gate.allowedNextActions,
          checkpointRequired: gate.checkpointRequired };
        emit({ ...gate, instruction: undefined, instructionInjected: false,
          boundary: 'tool-gate', eventId: input.callID, sessionID: input.sessionID });
      }
      if (input.tool === 'coop_plan_submit') await boundary('wait-start', { sessionID: input.sessionID });
    },
    'tool.execute.after': async input => {
      if (!belongs(input.sessionID)) return;
      if (input.tool === 'coop_plan_submit') await boundary('wait-end', { sessionID: input.sessionID });
      await boundary('tool-end', { eventId: input.callID, sessionID: input.sessionID });
    },
    event: async ({ event }) => {
      if (event.type !== 'message.part.updated') return;
      const part = event.properties?.part;
      if (part?.type === 'step-finish' && belongs(part.sessionID)) {
        await boundary('state', { sessionID: part.sessionID });
        return;
      }
      if (part?.type !== 'tool' || !belongs(part.sessionID)
        || !['completed', 'error', 'failed'].includes(part.state?.status)) return;
      const messageID = part.messageID;
      if (typeof messageID === 'string') await boundary('tool-step', {
        // Session/message IDs are stable across an OpenCode process restart, so
        // replayed part events cannot spend the same persisted step twice.
        eventId: `${part.sessionID ?? 'unknown'}:${messageID}`, sessionID: part.sessionID,
      });
    },
  };
}

export function composeAgentHooks(...sources) {
  const names = [...new Set(sources.flatMap(source => Object.keys(source)))];
  return Object.fromEntries(names.map(name => [name, async (...args) => {
    for (const source of sources) if (typeof source[name] === 'function') await source[name](...args);
  }]));
}
