import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPreparationError } from '../lib/phase-diagnostics.mjs';
import { PatchPlanError } from '../../../scripts/lib/patch-plan-executor.mjs';

test('preparation failures retain the concrete rejection without dumping the review graph', () => {
  const error = new PatchPlanError('PatchPlan pre-execution validation failed', ['[SCOPE_LEAK] Shared Unit', '[SCOPE_LEAK] Shared Unit']);
  error.review = { validationPhase: 'pre-execution', diagnostics: [
    { severity: 'error', code: 'SCOPE_LEAK', message: 'Shared Unit', consumers: Array(1000).fill('not exported') },
  ], changes: Array(1000).fill('not exported') };
  const result = compactPreparationError(error);
  assert.deepEqual(result.messages, ['[SCOPE_LEAK] Shared Unit']);
  assert.equal(result.diagnostics[0].code, 'SCOPE_LEAK');
  assert.equal(result.validationPhase, 'pre-execution');
  assert.ok(JSON.stringify(result).length < 1000);
  assert.ok(!JSON.stringify(result).includes('not exported'));
});

test('even pathological error lists are bounded and ordinary failures remain meaningful', () => {
  const error = new PatchPlanError('x'.repeat(2000), Array.from({ length: 100 }, (_, i) => `${i}-${'x'.repeat(2000)}`));
  const result = compactPreparationError(error);
  assert.equal(result.messages.length, 8);
  assert.ok(result.messages.every((s) => s.length <= 800));
  assert.equal(result.error.length, 800);
  assert.equal(compactPreparationError(new Error('Database busy')).error, 'Database busy');
});
