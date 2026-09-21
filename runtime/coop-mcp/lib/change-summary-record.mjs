function uniqueBy(items, keyOf) {
  const unique = new Map();
  for (const item of items) unique.set(keyOf(item), item);
  return [...unique.values()];
}

export function parseHistoricalSummaryIndex(document) {
  const documentKeys = document && typeof document === "object" ? Object.keys(document) : [];
  if (!document
    || documentKeys.some((key) => !["$schema", "formatVersion", "summaries"].includes(key))
    || (Object.hasOwn(document, "$schema") && typeof document.$schema !== "string")
    || document.formatVersion !== 1
    || !Array.isArray(document.summaries)) {
    throw new Error("Historical PatchPlan summary index must use formatVersion 1 and contain a summaries array.");
  }
  const summaries = new Map();
  for (const entry of document.summaries) {
    const entryKeys = entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!entry || entryKeys.join(",") !== "planId,text"
      || typeof entry.planId !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.planId)
      || entry.planId.length > 80
      || text.length < 4
      || text.length > 160
      || /[\r\n]/.test(entry.text)) {
      throw new Error("Every historical PatchPlan summary must contain only a valid planId and one 4–160 character line of text.");
    }
    if (summaries.has(entry.planId)) {
      throw new Error(`Historical PatchPlan summary '${entry.planId}' is duplicated.`);
    }
    summaries.set(entry.planId, text);
  }
  return summaries;
}

export function resolvePlanSummaryText(plan, historicalSummaries = new Map()) {
  const controlled = typeof plan?.userSummary?.text === "string"
    ? plan.userSummary.text.trim()
    : "";
  return controlled || historicalSummaries.get(plan.id) || plan.title || plan.id;
}

export function buildPlanSummaryRecord({ plan, receipt, changeItems, historicalSummaries }) {
  const operationExecutions = Array.isArray(receipt.operations) ? receipt.operations : [];
  const statuses = new Set(operationExecutions.map((operation) => operation.status).filter(Boolean));
  const status = statuses.has("changed")
    ? "changed"
    : statuses.size === 1
      ? [...statuses][0]
      : "applied";
  const catalogTargets = uniqueBy(
    changeItems.flatMap((item) => item.catalogTargets ?? []),
    (target) => `${target.catalog}/${target.objectId}/${target.path ?? ""}`,
  );
  const scopeUnitIds = [...new Set(catalogTargets
    .filter((target) => target.catalog === "Unit")
    .map((target) => target.objectId))];
  const commanderId = plan.scope?.kind === "commander"
    ? plan.scope.commanderId
    : changeItems.find((item) => item.commanderId)?.commanderId ?? null;
  const opIds = [...new Set(changeItems.flatMap((item) => item.opIds ?? []))];

  return {
    item: {
      id: plan.id,
      text: resolvePlanSummaryText(plan, historicalSummaries),
      kind: "patch-plan",
      commanderId,
      catalogTargets,
      before: null,
      after: null,
      field: null,
      opIds,
      status,
      verified: operationExecutions.length > 0
        && operationExecutions.every((operation) => operation.verified === true),
    },
    scopeUnitIds,
  };
}
