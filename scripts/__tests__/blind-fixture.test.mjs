import assert from 'node:assert/strict';
import test from 'node:test';
import { blindFixtureFile, blindModelConfig, blindTestEnvironment } from '../lib/blind-fixture.mjs';

test('blind fixture excludes answers, historical plans, traces and test implementations', () => {
  for (const file of ['docs/test-assets/reference/comm-001-wraith.mjs', 'docs/test-assets/runs/old.md',
    'scripts/manual-wraith-reference.mjs', 'scripts/__tests__/manual-wraith-reference.test.mjs',
    'scripts/scalar-parameter-regression.mjs', 'scripts/scalar-parameter-regression-report.mjs',
    'game-a/patches/old.patch-plan.json', 'game-a/patches/old.receipt.json', 'game-a/drafts/old.json',
    'game-a/runtime/agent-tasks.sqlite', 'runtime/coop-mcp/__tests__/test.mjs', 'docs/old-plan.md']) {
    assert.equal(blindFixtureFile(file), false, file);
  }
  for (const file of ['AGENTS.md', 'docs/patch-plan.md', 'docs/commander-edit-policy.md',
    'docs/private-unit-draft.md',
    'runtime/coop-mcp/lib/private-unit-draft.mjs',
    'scripts/lib/commander-edit-policy.mjs', 'docs/schemas/patch-plan-v2.schema.json',
    '.opencode/skills/coop-scalar-change/SKILL.md', 'docs/scalar-only.md', 'runtime/coop-mcp/lib/coop-search.mjs',
    '.opencode/skills/coop-query/SKILL.md', '.opencode/skills/coop-query/search.md',
    'runtime/coop-mcp/server.mjs', 'scripts/lib/agent-task.mjs', 'game-a/core/GameA.SC2Mod/GameA.Core.json']) {
    assert.equal(blindFixtureFile(file), true, file);
  }
});

test('blind model permissions forbid crossing fixture or reading linked runtimes', () => {
  const original = { agent: { 'coop-planner': { permission: { '*': 'deny', read: 'allow' } } } };
  const { permission } = blindModelConfig(original).agent['coop-planner'];
  assert.equal(permission.external_directory, 'deny');
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.coop_runtime_logs, 'deny');
  assert.equal(permission.read['.tools/*'], 'deny');
  assert.equal(permission.read['*'], 'deny');
  assert.equal(permission.read['.opencode/skills/coop-query/*'], 'allow');
  assert.equal(blindFixtureFile('.opencode/skills/coop-clone-unit/SKILL.md'), false);
  assert.equal(original.agent['coop-planner'].permission.read, 'allow');
});

test('blind runtime sessions and tool-output storage have a per-fixture home', () => {
  const a = blindTestEnvironment('/runs/one/project');
  const b = blindTestEnvironment('/runs/two/project');
  assert.notEqual(a.XDG_DATA_HOME, b.XDG_DATA_HOME);
  assert.match(a.XDG_DATA_HOME.replaceAll('\\', '/'), /\/runs\/one\/model-data$/);
});
