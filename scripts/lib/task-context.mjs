// No database imports: this identity parser also runs inside OpenCode/Bun.
export function taskContextFromEnvironment(env = process.env) {
  if (!env.COOPAGENT_TASK_ID) return null;
  const identity = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
  if (!identity(env.COOPAGENT_TASK_ID) || !identity(env.COOPAGENT_RUN_ID) || !/^[1-9][0-9]*$/.test(env.COOPAGENT_TASK_PHASE ?? '')) throw Error('Invalid task context');
  return { id: env.COOPAGENT_TASK_ID, runId: env.COOPAGENT_RUN_ID, phase: Number(env.COOPAGENT_TASK_PHASE) };
}
