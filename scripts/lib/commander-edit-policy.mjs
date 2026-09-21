// Authoring policy, NOT a change to PatchPlan execution semantics. No game data.
// Add a shortcut only with a bounded class/path/operation contract and evidence.
import { masteryPointSelector } from './mastery-point-editor.mjs';
export const COMMANDER_EDIT_POLICY_VERSION = 'clone-first-v1';
export const UPGRADE_SHORTCUTS = Object.freeze([
  Object.freeze({ id: 'unit-life-set-v1', catalog: 'Unit', className: 'CUnit',
    paths: Object.freeze(['LifeMax', 'LifeStart']), operation: 'commander.stat.set',
    scope: 'commander', valueType: 'finite-number', minimum: 0,
    evidence: 'docs/commander-edit-policy.md#upgrade-shortcuts' }),
]);

export function commanderEditRoute({ scope, catalog, objectId, className, path,
  value, changeType = 'scalar', existingScopedEdit = false, localObject = false }) {
  const base = { policy: COMMANDER_EDIT_POLICY_VERSION, defaultStrategy: 'private-clone' };
  if (scope?.kind === 'global') return { ...base, strategy: 'global', reason: 'explicit-global-scope' };
  if (scope?.kind !== 'commander') return { ...base, strategy: 'declare-scope', reason: 'scope-required' };
  // Keep an existing field's established representation; never silently migrate
  // prior Upgrade edits to a Catalog clone. This is not a new whitelist entry.
  if (changeType === 'scalar' && existingScopedEdit) return { ...base,
    strategy: 'player-upgrade', reason: 'existing-scoped-edit',
    note: 'Continue this exact existing Upgrade target; this is compatibility, not proof that other fields support Upgrade.' };
  if (changeType === 'scalar' && (className === 'CUpgrade'
    || className === 'CCommander' && /^MasteryTalentArray\[\d+\]\.ValuePerRank$/.test(path)
    || className === 'CUser' && objectId === 'MasteryUpgrades' && masteryPointSelector(path))) {
    return {...base, strategy: 'inspect-definition', reason: 'existing-catalog-definition',
      note: 'Use the current catalog.set candidate after checking this definition\'s actual commander/instance identity, activation and consumers. Declare scope and isolation explicitly. A private definition can be edited directly; shared consumers need an explicit isolation decision. Upgrade operands and mastery metadata do not imply cloning a Unit or generating another player Set.'};
  }
  const shortcut = changeType === 'scalar' && UPGRADE_SHORTCUTS.find(rule =>
    rule.catalog === catalog && rule.className === className && rule.paths.includes(path) &&
    typeof value === 'number' && Number.isFinite(value) && value >= rule.minimum);
  if (shortcut) return { ...base, strategy: 'player-upgrade', reason: 'upgrade-whitelist',
    whitelistId: shortcut.id, constraints: { operation: shortcut.operation, minimum: shortcut.minimum,
      note: 'Numeric-only Set intent; inspect both LifeMax and LifeStart. A mechanism change must still use the private route.' } };
  if (localObject) return { ...base, strategy: 'inspect-existing-private', reason: 'local-object-not-ownership-proof',
    note: 'Inspect existing creation routes, receipts and consumers first. Reuse a proven private object instead of cloning it again; local presence alone does not prove commander isolation.' };
  return { ...base, strategy: 'private-clone', reason: 'default-private-route',
    nextQuery: { operation: 'impact.analyze', catalog, objectId, scope,
      ...(catalog === 'Unit' ? { owner: { catalog, objectId } } : {}),
      changeType: 'structural', includeIsolationPlan: true },
    note: 'Clone the changed owner/dependency slice, reconnect a scoped entrypoint, and preserve unchanged references. For a dependency, identify the actual owner before writing. Not whitelisted does not mean impossible.' };
}
