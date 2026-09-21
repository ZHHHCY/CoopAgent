import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationWorkflow } from '../lib/authoring-workflow.mjs';
import { searchAgentView, replayAgentEvidence } from '../lib/search-agent-view.mjs';
import { createAgentTaskStore } from '../../../scripts/lib/agent-task.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('private unit isolation points directly to the draft capability, without embedding a long Skill or benchmark answer', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const guide = isolationWorkflow(repo, { recommendedStrategy: 'private-clone', owner: { catalog: 'Unit' } });
  assert.equal(guide.status, 'provided');
  assert.match(guide.workflow, /commander.unit.clone/);
  assert.equal(guide.draftBuilder.tool, 'coop_patch_plan_write');
  assert.equal(guide.draftBuilder.inputMode, 'privateUnit');
  assert(JSON.stringify(guide).length < 1400);
  assert.doesNotMatch(guide.workflow, /Wraith|GameAReference|COMM-001/);
  assert.equal(isolationWorkflow(repo, { recommendedStrategy: 'player-upgrade' }), null);
});

test('lossless evidence storage does not bypass compact replay, even after an original full query', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'coop-evidence-view-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createAgentTaskStore(root);
  const ctx = { id: 'task-replay', runId: 'run-replay', phase: 1 };
  store.begin({ ...ctx, prompt: 'test' }); store.open(ctx);
  const input = { operation: 'impact.analyze', catalog: 'Unit', objectId: 'Example', detailLevel: 'full' };
  const output = { nodes: Array.from({ length: 1000 }, () => ({ large: 'evidence'.repeat(25) })), edges: [1],
    semanticImpact: { targetKinds: ['unit'], consumers: ['long'] }, isolation: { recommendedStrategy: 'private-clone' } };
  const key = store.observe({ ...ctx, input, output });
  const record = createAgentTaskStore(root).evidence({ id: ctx.id, key });
  assert.deepEqual(store.get({ id: ctx.id, key }), output, 'audits retain exact evidence');
  assert.deepEqual(replayAgentEvidence(record), searchAgentView(output, { operation: input.operation }));
  assert.equal(replayAgentEvidence(record).nodes, undefined);
  assert.deepEqual(replayAgentEvidence(record, { detailLevel: 'full' }), output);
  assert(JSON.stringify(replayAgentEvidence(record)).length < 1000);
  assert.throws(() => store.evidence({ id: 'other-task', key }), /Unknown task/);
});

test('compact model impact preserves executable decisions while full diagnostic output remains available', () => {
  const result = { nodes: [1], edges: [2], semanticImpact: { targetKinds: ['unit'], completeness: 'bounded', consumers: [3] },
    isolation: { recommendedStrategy: 'private-clone', ownerEntrypoints: { creationRewires: [{ path: 'X[0]' }] } }, warnings: ['bounded'] };
  const compact = searchAgentView(result, { operation: 'impact.analyze' });
  assert.equal(compact.nodes, undefined);
  assert.deepEqual(compact.isolation, result.isolation);
  assert.deepEqual(compact.warnings, result.warnings);
  assert.equal(searchAgentView(result, { operation: 'impact.analyze', detailLevel: 'full' }), result);
});

test('large consumer and entrypoint sets are bounded with explicit expansion counts', () => {
  const group = i => ({ role: 'progression', source: { catalog: 'Upgrade', objectId: `U${i}` }, scopeStatus: 'unresolved',
    paths: Array.from({ length: 20 }, (_, n) => ({ path: `EffectArray[${n}].Reference`, relation: 'upgrade_affects', patchable: false,
      reviewRequired: true, edit: { available: false, reason: 'needs-exact-query', operation: { path: `EffectArray[${n}].Reference` } } })) });
  const ready = { catalog: 'Abil', objectId: 'Train', path: 'InfoArray[Train1].Unit[0]', expect: 'Ship',
    mechanism: 'commander.unit.clone.redirects' };
  const full = { directConsumers: Array.from({ length: 100 }, (_, i) => ({ catalog: 'Upgrade', objectId: `U${i}`, fieldPath: 'EffectArray[0].Reference' })),
    isolation: { ownerEntrypoints: { progression: Array.from({ length: 30 }, (_, i) => group(i)), creationRewires: [ready] } } };
  const result = searchAgentView(full, { operation: 'impact.analyze' });
  assert.equal(result.directConsumers.length, 12);
  assert.equal(result.isolation.ownerEntrypoints.progression.length, 4);
  assert.equal(result.isolation.ownerEntrypoints.progression[0].paths.length, 3);
  assert(result.isolation.ownerEntrypoints.progression[0].exactQueryRequired);
  assert.equal(result.expansion.slices['entrypoints.progression'].total, 30);
  assert(result.expansion.slices['entrypoints.progression'].truncated);
  assert.deepEqual(result.isolation.ownerEntrypoints.creationRewires, [ready]);
  assert.equal(full.isolation.ownerEntrypoints.progression.length, 30, 'no mutation of persisted/UI evidence');
});
