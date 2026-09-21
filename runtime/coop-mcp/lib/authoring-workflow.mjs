// Capability handoff, not another copy of a long Skill inside query output.
export function isolationWorkflow(_repoRoot, isolation) {
  if (isolation?.recommendedStrategy !== 'private-clone' || isolation.owner?.catalog !== 'Unit') return null;
  return { status: 'provided', skill: 'coop-clone-unit',
    draftBuilder: { tool: 'coop_patch_plan_write', inputMode: 'privateUnit',
      requires: ['id', 'title', 'summary', 'commanderId', 'sourceUnit', 'sourceActor', 'redirects'],
      changes: 'Optional exact source fields plus chosen values; saves the root clone first when omitted.' },
    workflow: 'Use privateUnit to save explicit commander.unit.clone, dependency clones and verified rewires. Continue the same PatchPlan toward a useful playable candidate; prepare/submit after executor checks pass, and disclose remaining compatibility or gameplay follow-ups. Gaps are reminders, not a full-completion gate.',
    boundary: 'The helper does not choose gameplay values, invent an owner path, preserve every upgrade automatically or verify gameplay.' };
}
