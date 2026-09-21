#!/usr/bin/env node
// Persistent JSONL bridge for the OpenCode Bun plugin. Keeping node:sqlite in
// this Node process avoids one process launch per harness boundary.
import { createInterface } from 'node:readline';
import { createAgentTaskStore } from './lib/agent-task.mjs';

const root = process.argv[2] ?? process.cwd();
const store = createAgentTaskStore(root);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let id = null;
  try {
    const request = JSON.parse(line); id = request.id;
    const result = store.harnessControl(request.input);
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: { message: error.message } })}\n`);
  }
}
