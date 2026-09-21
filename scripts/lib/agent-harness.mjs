export const ITERATIVE_HARNESS_ENABLED = process.env.COOPAGENT_ITERATIVE_HARNESS !== '0';

export const DEFAULT_TURN_BUDGET = Object.freeze({
  workMs: 180_000,
  workSteps: 12,
  extensionMs: 90_000,
  extensionSteps: 6,
  finalMs: 60_000,
  finalSteps: 2,
});

export const TURN_HARD_BUDGET_MS = DEFAULT_TURN_BUDGET.workMs
  + DEFAULT_TURN_BUDGET.extensionMs + DEFAULT_TURN_BUDGET.finalMs;
export const SUBMISSION_WAIT_HARD_MS = 240_000;

const prompts = {
  closing: '宿主收尾提示：本轮探索已进入长尾。已有证据能回答问题就交付；修改任务完成已成形且范围正确的方案，或交付已完成部分与遗漏。只为仍影响本次答案或实施的具体缺口补查，不开始广泛调查，不降低写入标准。用 task_checkpoint.summary 给出完整答复。',
  final: '宿主最终收尾：停止新调查。基于已有证据回答，或提交已经成形且通过校验的方案；需要时查看已有提交状态。仍未解决的部分明确说明，用 task_checkpoint 交付。应用状态以后端与 Receipt 为准。',
};

const boundedIds = ids => [...new Set((ids ?? []).filter(v => typeof v === 'string'))].slice(-128);

export function createTurnBudget(startedAt = null, limits = DEFAULT_TURN_BUDGET) {
  return { version: 1, limits: { ...DEFAULT_TURN_BUDGET, ...limits }, startedAt,
    activeElapsedMs: 0, segmentStartedAt: startedAt, stageStartedElapsedMs: 0,
    toolSteps: 0, stage: 'work', stageStartedAt: startedAt, stageStartedStep: 0,
    promptsInjected: [], eventIds: [], closeReason: null, closeSignal: null,
    firstUsefulResultAtActiveMs: null };
}

function normalize(previous, now) {
  const state = structuredClone(previous ?? createTurnBudget(now));
  state.limits = { ...DEFAULT_TURN_BUDGET, ...state.limits };
  state.activeElapsedMs ??= state.stage === 'stopped'
    ? state.limits.workMs + state.limits.extensionMs + state.limits.finalMs
    : state.stage === 'final' ? state.limits.workMs + state.limits.extensionMs
    : state.stage === 'closing' ? state.limits.workMs : 0;
  state.segmentStartedAt ??= null;
  state.stageStartedElapsedMs ??= state.stage === 'final'
    ? state.limits.workMs + state.limits.extensionMs
    : state.stage === 'closing' ? state.limits.workMs : 0;
  state.closeSignal ??= null; state.firstUsefulResultAtActiveMs ??= null;
  return state;
}

const explorationTools = new Set(['search', 'search_batch', 'coop_search', 'coop_search_batch']);
const closeoutTools = new Set(['project_status', 'coop_project_status', 'scalar_solve', 'coop_scalar_solve',
  'plan_prepare', 'coop_plan_prepare', 'plan_submit', 'coop_plan_submit', 'scalar_change', 'coop_scalar_change', 'target_confirm',
  'coop_target_confirm', 'task_checkpoint', 'coop_task_checkpoint']);

/** Decide before dispatch whether a new tool call may do exploratory work.
 * Closing remains bounded by its time/step extension, so a precise evidence
 * chain may finish without a second tool-name quota. Final blocks new lookup.
 * Already-started submissions are never gated. */
export function gateTurnTool(previous, { tool, callId }) {
  const state = normalize(previous, 0);
  if (state.stage !== 'final' || closeoutTools.has(tool) || !explorationTools.has(tool)) {
    return { state, action: 'dispatch', stage: state.stage };
  }
  return { state, action: 'closeout', stage: state.stage, reason: 'final-exploration-blocked',
  allowedNextActions: ['project_status', 'scalar_solve', 'plan_prepare', 'plan_submit', 'scalar_change',
    'target_confirm', 'task_checkpoint'] };
}

function accrue(state, now, activeDeltaMs) {
  if (state.segmentStartedAt == null) return;
  const delta = activeDeltaMs === undefined ? Math.max(0, now - state.segmentStartedAt) : activeDeltaMs;
  if (!Number.isFinite(delta) || delta < 0 || delta > 86_400_000) throw Error('Invalid active turn time');
  state.activeElapsedMs += delta;
  state.segmentStartedAt = now;
}

export function pauseTurnBudget(previous, now, activeDeltaMs) {
  const state = normalize(previous, now); accrue(state, now, activeDeltaMs); state.segmentStartedAt = null; return state;
}

export function resumeTurnBudget(previous, now) {
  const state = normalize(previous, now); state.segmentStartedAt = now; return state;
}

export function remainingTurnBudgetMs(previous) {
  const state = normalize(previous, 0), limits = state.limits;
  return Math.max(0, limits.workMs + limits.extensionMs + limits.finalMs - state.activeElapsedMs);
}

function transition(state, stage, now, reason, step = state.toolSteps, elapsed = state.activeElapsedMs) {
  if (state.stage === stage || state.stage === 'stopped') return;
  state.stage = stage; state.stageStartedAt = now; state.stageStartedStep = step;
  state.stageStartedElapsedMs = elapsed;
  state.closeReason = reason;
}

// This controller deliberately counts model tool-execution steps, not MCP calls.
// The adapter supplies one stable event ID per assistant message that contains tools.
export function advanceTurnBudget(previous, { now, kind, eventId = null, consumePrompt = false,
  closeSignal = null, activeDeltaMs } = {}) {
  const state = normalize(previous, now);
  state.startedAt ??= now; state.stageStartedAt ??= state.startedAt;
  accrue(state, now, activeDeltaMs);
  state.eventIds = boundedIds(state.eventIds);
  if (kind === 'tool-step' && eventId && !state.eventIds.includes(eventId)) {
    state.eventIds.push(eventId); state.eventIds = boundedIds(state.eventIds); state.toolSteps++;
  }
  const elapsedMs = state.activeElapsedMs;
  const l = state.limits;
  const closeAtMs = l.workMs;
  const closeAtStep = l.workSteps;
  const hardAtMs = closeAtMs + l.extensionMs + l.finalMs;
  const hardAtStep = closeAtStep + l.extensionSteps + l.finalSteps;

  if (closeSignal) {
    state.closeSignal = closeSignal;
    if (closeSignal === 'deliverable-result' && state.firstUsefulResultAtActiveMs == null) {
      state.firstUsefulResultAtActiveMs = elapsedMs;
    }
  }
  if (state.stage === 'work' && closeSignal) transition(state, 'closing', now, closeSignal);
  if (state.stage === 'work' && (elapsedMs >= closeAtMs || state.toolSteps >= closeAtStep)) {
    const byTime = elapsedMs >= closeAtMs;
    transition(state, 'closing', now, byTime ? 'work-time' : 'work-steps',
      byTime ? state.toolSteps : closeAtStep, byTime ? closeAtMs : elapsedMs);
  }
  const closingMs = Math.max(0, elapsedMs - state.stageStartedElapsedMs);
  const closingSteps = Math.max(0, state.toolSteps - state.stageStartedStep);
  if (state.stage === 'closing' && (closingMs >= l.extensionMs || closingSteps >= l.extensionSteps)) {
    const byTime = closingMs >= l.extensionMs;
    transition(state, 'final', now,
      byTime ? 'extension-time' : 'extension-steps',
      byTime ? state.toolSteps : state.stageStartedStep + l.extensionSteps,
      byTime ? state.stageStartedElapsedMs + l.extensionMs : elapsedMs);
  }
  const finalMs = Math.max(0, elapsedMs - state.stageStartedElapsedMs);
  const finalSteps = Math.max(0, state.toolSteps - state.stageStartedStep);
  if (state.stage === 'final' && (finalMs >= l.finalMs || finalSteps >= l.finalSteps)) {
    transition(state, 'stopped', now, finalMs >= l.finalMs ? 'final-time' : 'final-steps');
  }
  // An early deliverable can shorten a turn, but never extends the absolute cap.
  if (elapsedMs >= hardAtMs || state.toolSteps >= hardAtStep) {
    transition(state, 'stopped', now, elapsedMs >= hardAtMs ? 'hard-time' : 'hard-steps');
  }

  let instruction = null;
  if (consumePrompt && (state.stage === 'closing' || state.stage === 'final')
    && !state.promptsInjected.includes(state.stage)) {
    state.promptsInjected.push(state.stage); instruction = prompts[state.stage];
  }
  return { state, action: state.stage === 'stopped' ? 'stop'
    : state.stage === 'work' ? 'continue' : 'close', stage: state.stage,
  elapsedMs, toolSteps: state.toolSteps, reason: state.closeReason, instruction };
}
