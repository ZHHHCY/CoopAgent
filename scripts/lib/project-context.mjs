import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

// Code is always resolved relative to the installation, never the user project.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function workspaceRoot() {
  return path.resolve(process.env.COOPAGENT_WORKSPACE_ROOT || APP_ROOT);
}
export function applicationRoot(repoRoot = APP_ROOT) {
  return process.env.COOPAGENT_WORKSPACE_ROOT || existsSync(path.join(repoRoot, 'coop-project.json')) ? APP_ROOT : repoRoot;
}
export function projectIdentity(repoRoot) {
  const file = path.join(repoRoot, 'coop-project.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).projectId : null;
}
export function projectEnvironment(repoRoot) {
  const file = path.join(repoRoot, 'coop-project.json');
  if (!existsSync(file)) return process.env;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  return { ...process.env, COOPAGENT_WORKSPACE_ROOT: path.resolve(repoRoot), COOPAGENT_PROJECT_ID: manifest.projectId,
    COOPAGENT_TEMPLATE_ROOT: manifest.legacy ? APP_ROOT : path.join(APP_ROOT, 'game-a/templates', manifest.templateId, manifest.templateVersion) };
}
