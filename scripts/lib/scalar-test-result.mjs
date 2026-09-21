const RESULT_CLASSES = new Set([
  'modification-complete',
  'no-change',
  'awaiting-user-confirmation',
  'capability-gap',
  'no-effective-delivery',
  'machine-error',
]);

const VERIFICATION_LEVELS = new Set(['not_checked', 'static_checked', 'runtime_checked']);

/** Classify a supervised scalar result without conflating application state,
 * delivery usefulness, and verification depth. A zero-submit unresolved turn
 * is only a capability gap when it contains a concrete, evidence-backed gap. */
export function classifyScalarTestResult(input = {}) {
  const verification = VERIFICATION_LEVELS.has(input.verification) ? input.verification : 'not_checked';
  let resultClass;
  if (input.machineError) resultClass = 'machine-error';
  else if (input.awaitingConfirmation) resultClass = 'awaiting-user-confirmation';
  else if (input.independentNoChange === true) resultClass = 'no-change';
  else if (input.independentModificationSatisfied === true && input.applicationStatus === 'applied') {
    resultClass = 'modification-complete';
  } else if (input.concreteCapabilityGap === true && typeof input.gap === 'string' && input.gap.trim()) {
    resultClass = 'capability-gap';
  } else resultClass = 'no-effective-delivery';

  return {
    resultClass,
    verification,
    modificationCompleted: resultClass === 'modification-complete',
    usefulCloseout: ['modification-complete', 'no-change', 'awaiting-user-confirmation', 'capability-gap'].includes(resultClass),
    receiptRequired: resultClass === 'modification-complete',
    ...(resultClass === 'capability-gap' ? { gap: input.gap.trim() } : {}),
  };
}

export function assertScalarResultClass(value) {
  if (!RESULT_CLASSES.has(value)) throw Error(`Unknown scalar result class: ${value}`);
  return value;
}
