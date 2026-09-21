import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentTaskStore } from '../../../scripts/lib/agent-task.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('persistent harness controller serves multiple ordered boundaries in one Node process', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createAgentTaskStore(root, { now: () => 1_000, harnessEnabled: true });
  store.begin({ id: 'task-one', runId: 'run-one', prompt: 'test' });
  const opened = store.open({ id: 'task-one', runId: 'run-one' });
  const child = spawn(process.execPath, [path.join(source, 'scripts/harness-control.mjs'), root], {
    cwd: source, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  const done = new Promise((resolve, reject) => {
    lines.on('line', line => { responses.push(JSON.parse(line)); if (responses.length === 2) resolve(); });
    child.on('error', reject);
  });
  const context = { id: 'task-one', runId: 'run-one', phase: opened.task.phase };
  child.stdin.write(`${JSON.stringify({ id: 'a', input: { ...context, kind: 'before-model', activeDeltaMs: 25 } })}\n`);
  child.stdin.write(`${JSON.stringify({ id: 'b', input: { ...context, kind: 'tool-step', eventId: 'm1', activeDeltaMs: 5 } })}\n`);
  await done;
  child.stdin.end();
  await new Promise(resolve => child.on('close', resolve));
  assert.deepEqual(responses.map(response => response.id), ['a', 'b']);
  assert.equal(responses[1].result.toolSteps, 1);
  assert.equal(responses[1].result.elapsedMs, 30);
});
