import path from 'node:path';

// A fixture is a data-isolation boundary, not an instruction asking the model
// to ignore answers. Keep benchmark inputs/references in the observer project.
export function blindFixtureFile(name) {
  name = name.replaceAll('\\', '/');
  if (/^(AGENTS\.md|opencode\.json|package\.json|\.gitignore)$/.test(name)) return true;
  if (name === '.opencode/plugins/coop-trace.js') return true;
  if (/^(\.opencode\/skills\/coop-(scalar-change|query)\/|docs\/schemas\/)/.test(name)) return true;
  if (name.startsWith('.opencode/skills/')) return false;
  if (name === 'docs/scalar-only.md') return true;
  if (/^docs\/(patch-plan|commander-edit-policy)\.md$/.test(name)) return true;
  if (/^docs\//.test(name)) return false;
  if (/(^|\/)(__tests__|test-assets|examples|fixtures|drafts|patches|build|runtime|maps)(\/|$)/.test(name.replace(/^runtime\//, 'implementation/'))) return false;
  if (/(manual-|wraith|regression|agent-test|agent-task)/i.test(name) && !/^scripts\/(lib\/)?agent-task\.mjs$/.test(name)) return false;
  return /^(scripts\/|runtime\/|game-a\/)/.test(name);
}

export function blindModelConfig(config, root) {
  const result = structuredClone(config);
  result.agent['coop-planner'].permission.external_directory = 'deny';
  for (const tool of ['coop_runtime_logs', 'coop_runtime_verify', 'coop_runtime_test_status']) {
    result.agent['coop-planner'].permission[tool] = 'deny';
  }
  // All subprocess/file-write/network tools were already denied. Also prevent
  // reading Git internals if the model explores the isolated project.
  result.agent['coop-planner'].permission.read = {
    '*': 'deny', 'docs/scalar-only.md': 'allow', 'docs/patch-plan.md': 'allow', 'docs/schemas/*': 'allow',
    '.opencode/skills/coop-scalar-change/*': 'allow',
    '.opencode/skills/coop-query/*': 'allow',
  };
  for (const folder of ['.git', '.tools', 'node_modules', 'runtime/coop-mcp/node_modules']) {
    result.agent['coop-planner'].permission.read[`${folder}/*`] = 'deny';
    if (root) result.agent['coop-planner'].permission.read[`${root.replaceAll('\\', '/')}/${folder}/*`] = 'deny';
  }
  return result;
}

export function blindTestEnvironment(root) {
  const parent = path.dirname(root);
  return { XDG_DATA_HOME: path.join(parent, 'model-data'), XDG_STATE_HOME: path.join(parent, 'model-state') };
}
