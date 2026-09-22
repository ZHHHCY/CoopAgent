#!/usr/bin/env node
import { createAgentTaskStore } from './lib/agent-task.mjs';
import { readSessionHistory } from './lib/session-history.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const [operation, root = process.cwd()] = process.argv.slice(2);
  if (!['begin', 'open', 'finish', 'get', 'harness-control', 'history'].includes(operation)) {
    throw Error('Use begin, open, finish, get, harness-control or history');
  }
  const method = operation === 'harness-control' ? 'harnessControl' : operation;
  const value = JSON.parse(input || '{}');
  const result = operation === 'history' ? readSessionHistory(root, value) : createAgentTaskStore(root)[method](value);
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
