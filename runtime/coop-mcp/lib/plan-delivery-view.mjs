// Project the existing authoring ledger; do not infer requirements from solver
// calls, introduce a second ledger, or turn exploratory revisions into gates.
export function compactPlanResult(value) {
  const { delivery, ...result } = value;
  if (result.warnings?.length) result.warnings = result.warnings.map(warning => ({
    ...warning, blocking: false,
    ...(warning.code === 'DIRECT_PRIVATE_NOT_PROVEN' ? {
      action: 'Check ownership and relevant consumers if unresolved. Reuse existing evidence; this warning is not proof of a leak or a request to audit executor source.',
    } : {}),
  }));
  if (!delivery?.openCount) return result;
  const open = (delivery.items ?? []).filter(item => item.status === 'open');
  return { ...result, deliveryReminder: {
    policy: 'advisory', openCount: delivery.openCount,
    items: open.slice(0, 8).map(({ id, kind, description }) => ({ id, kind, description: description.slice(0, 500) })),
    omittedCount: Math.max(0, open.length - 8),
    note: 'Earlier drafts contain changes or follow-ups absent from this plan. Check against the user request; intentional discarded candidates need not be restored. This task selects ONE final plan containing all requested changes. This reminder is not a submission gate or gameplay proof.',
  } };
}
