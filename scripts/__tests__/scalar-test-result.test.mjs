import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyScalarTestResult } from '../lib/scalar-test-result.mjs';

test('scalar result categories are independent from verification depth and receipts', () => {
  assert.deepEqual(classifyScalarTestResult({ independentNoChange: true, verification: 'static_checked' }), {
    resultClass: 'no-change', verification: 'static_checked', modificationCompleted: false,
    usefulCloseout: true, receiptRequired: false,
  });
  assert.equal(classifyScalarTestResult({ applicationStatus: 'applied',
    independentModificationSatisfied: true, verification: 'not_checked' }).resultClass, 'modification-complete');
  assert.equal(classifyScalarTestResult({ awaitingConfirmation: true }).resultClass, 'awaiting-user-confirmation');
});

test('zero-submit unresolved is not useful unless it reports a concrete capability gap', () => {
  const generic = classifyScalarTestResult({ applicationStatus: 'not_submitted', modelOutcome: 'unresolved' });
  assert.equal(generic.resultClass, 'no-effective-delivery');
  assert.equal(generic.usefulCloseout, false);
  const gap = classifyScalarTestResult({ applicationStatus: 'not_submitted', modelOutcome: 'unresolved',
    concreteCapabilityGap: true, gap: '缺少可证明的威望激活时序。', verification: 'static_checked' });
  assert.equal(gap.resultClass, 'capability-gap');
  assert.equal(gap.modificationCompleted, false);
  assert.equal(gap.usefulCloseout, true);
});

test('machine errors take precedence over semantic classifications', () => {
  const result = classifyScalarTestResult({ machineError: 'backend exited', independentNoChange: true,
    awaitingConfirmation: true, verification: 'runtime_checked' });
  assert.equal(result.resultClass, 'machine-error');
  assert.equal(result.verification, 'runtime_checked');
  assert.equal(result.usefulCloseout, false);
});
