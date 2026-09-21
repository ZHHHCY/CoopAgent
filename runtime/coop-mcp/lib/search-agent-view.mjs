// UI/diagnostics retain the full shared interpretation. The model normally
// needs the actionable slice, not three copies of the same reference graph.
export function searchAgentView(result, input) {
  if (input.operation !== 'impact.analyze' || input.detailLevel === 'full') return result;
  const { nodes, edges, semanticImpact, commanders, ...compact } = result;
  const slices = {};
  const take = (name, items, limit, project = value => value) => {
    if (!Array.isArray(items)) return items;
    slices[name] = { total: items.length, shown: Math.min(items.length, limit), truncated: items.length > limit };
    return items.slice(0, limit).map(project);
  };
  for (const field of ['directConsumers', 'directDependencies', 'unownedConsumers']) {
    if (compact[field]) compact[field] = take(field, compact[field], 12, ({ catalog, objectId, fieldPath, relation, confidence }) =>
      ({ catalog, objectId, ...(fieldPath ? { fieldPath } : {}), ...(relation ? { relation } : {}), ...(confidence !== undefined ? { confidence } : {}) }));
  }
  if (compact.isolation) {
    const isolation = { ...compact.isolation };
    if (isolation.outsideScopeConsumers) isolation.outsideScopeConsumers = take('isolation.outsideScopeConsumers', isolation.outsideScopeConsumers, 8);
    if (isolation.ownerPaths) isolation.ownerPaths = take('isolation.ownerPaths', isolation.ownerPaths, 4);
    if (isolation.ownerEntrypoints) {
      const entries = { ...isolation.ownerEntrypoints };
      for (const role of ['creation', 'requirement', 'progression', 'visual', 'profile', 'other']) {
        if (!entries[role]) continue;
        entries[role] = take(`entrypoints.${role}`, entries[role], 4, group => ({
          source: group.source, role: group.role, scopeStatus: group.scopeStatus,
          paths: take(`entrypoints.${role}.${group.source.catalog}/${group.source.objectId}`, group.paths, 3, entry => ({
            path: entry.path, relation: entry.relation, patchable: entry.patchable, reviewRequired: entry.reviewRequired,
            ...(entry.edit?.reason ? { reason: entry.edit.reason } : {}) })),
          exactQueryRequired: true,
        }));
      }
      if (entries.creationRewires) entries.creationRewires = take('entrypoints.creationRewires', entries.creationRewires, 32);
      isolation.ownerEntrypoints = entries;
    }
    compact.isolation = isolation;
  }
  return { ...compact,
    commanders: (commanders ?? []).map(({ commanderId, id, nameZhcn, nameEnus }) => ({ commanderId: commanderId ?? id, nameZhcn, nameEnus })),
    semanticImpact: semanticImpact ? { targetKinds: semanticImpact.targetKinds, completeness: semanticImpact.completeness } : null,
    expansion: { detailLevel: 'full', slices, omitted: ['nodes', 'edges', 'semanticImpact relationship groups', 'non-creation entrypoint edit descriptors'],
      note: 'Use the same query with detailLevel=full only for a specific missing relationship. Omitted graphs are not evidence of absence.' },
  };
}

// Stored evidence is deliberately lossless for diagnostics. Replay through the
// same model projection, even when the original query explicitly requested full.
export function replayAgentEvidence(record, { detailLevel = 'overview' } = {}) {
  return searchAgentView(record.output, { ...record.input, detailLevel });
}
