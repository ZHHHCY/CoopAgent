#!/usr/bin/env node
import { createAgentTaskStore } from './lib/agent-task.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const [operation, root = process.cwd()] = process.argv.slice(2);
  if (!['begin', 'open', 'finish', 'get', 'harness-control'].includes(operation)) {
    throw Error('Use begin, open, finish, get or harness-control');
  }
  const method = operation === 'harness-control' ? 'harnessControl' : operation;
  const result = createAgentTaskStore(root)[method](JSON.parse(input || '{}'));
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
