import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { APP_ROOT } from './project-context.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'coop-project.json';
async function publishDirectory(staging, target) {
  // Windows scanners may briefly retain handles to newly copied Galaxy files.
  for (let attempt = 0; ; attempt++) {
    if (existsSync(target)) throw Error('目标目录已存在');
    try { await rename(staging, target); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 12) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function atomicFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content, { flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function files(root, relative = '') {
  const rows = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name = [relative, entry.name].filter(Boolean).join('/');
    if (entry.isSymbolicLink()) throw Error(`项目源不允许链接：${name}`);
    if (entry.isDirectory()) rows.push(...await files(root, name));
    else if (entry.isFile()) rows.push(name);
  }
  return rows;
}
export async function verifyTemplate(templateRoot, appRoot = APP_ROOT) {
  const template = await readJson(path.join(templateRoot, 'template.json'));
  await verifyTemplateFiles(templateRoot, template);
  for (const [name, expected] of Object.entries(template.sharedInputs ?? {})) {
    const sharedPath = path.join(appRoot, name);
    if (!existsSync(sharedPath)) {
      const hint = name.startsWith('game-a/projects/') ? '内置 Game A 宿主缺失，请恢复完整的 CoopAgent 源码' : '请先准备共享输入';
      throw Error(`${hint}：${name}`);
    }
    if (hash(await readFile(sharedPath)) !== expected) throw Error(`模板共享宿主已改变，需显式迁移：${name}`);
  }
  return { ...template, templateHash: templateHash(template) };
}
async function verifyTemplateFiles(templateRoot, template) {
  const actual = (await files(path.join(templateRoot, 'game-a'))).map(x=>`game-a/${x}`);
  if (actual.length !== Object.keys(template.files).length) throw Error('默认模板文件清单不匹配');
  for (const name of actual) {
    if (hash(await readFile(path.join(templateRoot, name))) !== template.files[name]) throw Error(`默认模板已改变：${name}`);
  }
}
const templateHash = template => hash(Buffer.from(JSON.stringify({files:template.files,sharedInputs:template.sharedInputs ?? {}})));
const defaultTemplateRoot = appRoot => path.join(appRoot, 'game-a/templates/coop-default-v1/6');
function projectName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw Error('项目名称需为 1–80 个字符');
  return name.trim();
}
export async function createProject({ directory, name, appRoot = APP_ROOT }) {
  const target = path.resolve(directory);
  if (existsSync(target)) throw Error('新项目目录已存在，请选择一个新的目录');
  const templateRoot = defaultTemplateRoot(appRoot);
  const template = await verifyTemplate(templateRoot, appRoot);
  const manifest = { schemaVersion: 1, projectId: randomUUID(), name: projectName(name), createdAt: new Date().toISOString(),
    templateId: template.templateId, templateVersion: template.templateVersion, templateHash: template.templateHash,
    dataBuild: template.dataBuild, runtimeContract: template.runtimeContract };
  await mkdir(path.dirname(target), { recursive: true });
  const staging = path.join(path.dirname(target), `.coop-create-${randomUUID()}`);
  await mkdir(staging);
  try {
    await cp(path.join(templateRoot, 'game-a'), path.join(staging, 'game-a'), { recursive: true, errorOnExist: true, force: false });
    for (const folder of ['game-a/patches', 'game-a/drafts', 'game-a/runtime', '.coopagent/opencode', '.coopagent/traces']) await mkdir(path.join(staging, folder), { recursive: true });
    await atomicJson(path.join(staging, manifestName), manifest);
    // Rename publishes a complete directory; never merge into an existing project.
    if (existsSync(target)) throw Error('目标目录已存在');
    await publishDirectory(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return openProject(target, { appRoot });
}
export async function openProject(directory, { appRoot = APP_ROOT } = {}) {
  const workspaceRoot = await realpath(directory);
  const manifest = await readJson(path.join(workspaceRoot, manifestName));
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.projectId)) throw Error('不支持的项目格式');
  projectName(manifest.name);
  if (!existsSync(path.join(workspaceRoot, 'game-a/core/GameA.SC2Mod/GameA.Core.json'))) throw Error('项目核心源缺失');
  let templateRoot = appRoot;
  if (!manifest.legacy) {
    if (!/^[a-z0-9-]+$/.test(manifest.templateId) || !/^\d+$/.test(manifest.templateVersion)) throw Error('模板标识无效');
    templateRoot = path.join(appRoot, 'game-a/templates', manifest.templateId, manifest.templateVersion);
    const template = await verifyTemplate(templateRoot, appRoot);
    if (template.templateHash !== manifest.templateHash || template.dataBuild !== manifest.dataBuild || template.runtimeContract !== manifest.runtimeContract) throw Error('项目模板或数据库版本不兼容，需显式迁移');
    for (const file of ['runtime-baseline.json', 'hosts.json']) {
      if (!Buffer.from(await readFile(path.join(workspaceRoot, 'game-a', file))).equals(await readFile(path.join(templateRoot, 'game-a', file)))) throw Error(`项目只读配置已改变：${file}`);
    }
    // Reject redirected writable roots, including Windows junctions.
    for (const folder of ['game-a', 'game-a/core', 'game-a/core/GameA.SC2Mod', 'game-a/runtime', 'game-a/patches', 'game-a/drafts', '.coopagent',
      'game-a/build', '.coopagent/opencode', '.coopagent/traces', '.coopagent/ui.json']) {
      if (!existsSync(path.join(workspaceRoot, folder))) continue;
      if ((await lstat(path.join(workspaceRoot, folder))).isSymbolicLink()) throw Error(`项目可写目录不允许链接：${folder}`);
    }
  }
  const databaseFile = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local/share'), 'CoopAgent/database', manifest.dataBuild, 'coop.sqlite');
  return { ...manifest, appRoot, workspaceRoot, templateRoot, databaseFile };
}
export async function legacyProject(appRoot = APP_ROOT) {
  const file = path.join(appRoot, manifestName);
  if (!existsSync(file)) {
    const baseline = await readJson(path.join(appRoot, 'game-a/runtime-baseline.json'));
    await atomicJson(file, { schemaVersion: 1, projectId: randomUUID(), name: '现有修改', createdAt: new Date().toISOString(),
      templateId: 'legacy', templateVersion: '1', templateHash: 'legacy', dataBuild: baseline.sc2.dataBuild,
      runtimeContract: baseline.schemaVersion, legacy: true });
  }
  return openProject(appRoot, { appRoot });
}
export async function renameProject(directory, name, options) {
  const context = await openProject(directory, options);
  const manifest = await readJson(path.join(context.workspaceRoot, manifestName));
  manifest.name = projectName(name);
  await atomicJson(path.join(context.workspaceRoot, manifestName), manifest);
  return { ...context, name: manifest.name };
}
export async function migrateProject(directory, { appRoot = APP_ROOT } = {}) {
  const workspaceRoot = await realpath(directory);
  const manifestPath = path.join(workspaceRoot, manifestName);
  const manifest = await readJson(manifestPath);
  if (manifest.legacy) throw Error('现有修改项目不使用版本化模板');
  if (manifest.templateId !== 'coop-default-v1') throw Error(`不支持迁移模板：${manifest.templateId}`);

  const sourceRoot = path.join(appRoot, 'game-a/templates', manifest.templateId, manifest.templateVersion);
  const source = await readJson(path.join(sourceRoot, 'template.json'));
  await verifyTemplateFiles(sourceRoot, source);
  if (manifest.templateHash !== templateHash(source)) throw Error('项目原模板记录不匹配，不能迁移');

  const targetRoot = defaultTemplateRoot(appRoot);
  const target = await verifyTemplate(targetRoot, appRoot);
  if (source.dataBuild !== target.dataBuild || source.runtimeContract !== target.runtimeContract) {
    throw Error('目标模板改变了数据库或运行契约，不能执行无损迁移');
  }
  for (const file of ['runtime-baseline.json', 'hosts.json']) {
    if (!Buffer.from(await readFile(path.join(workspaceRoot, 'game-a', file))).equals(await readFile(path.join(sourceRoot, 'game-a', file)))) {
      throw Error(`项目只读配置已改变：${file}`);
    }
  }
  const originalManifest = structuredClone(manifest);
  let originalDifficulty = null;
  let originalCoreManifest = null;
  const difficultyRelative = 'game-a/core/GameA.SC2Mod/Base.SC2Data/Generated/PreparationOptions.galaxy';
  const coreManifestRelative = 'game-a/core/GameA.SC2Mod/GameA.Core.json';
  const difficultyPath = path.join(workspaceRoot, difficultyRelative);
  const coreManifestPath = path.join(workspaceRoot, coreManifestRelative);
  try {
    if (Number(source.templateVersion) < 5 && Number(target.templateVersion) >= 5) {
      const sourceDifficulty = await readFile(path.join(sourceRoot, difficultyRelative));
      originalDifficulty = await readFile(difficultyPath);
      if (!originalDifficulty.equals(sourceDifficulty)) throw Error('项目准备选项模块已自行修改，不能自动迁移准备状态修复');
      originalCoreManifest = await readJson(coreManifestPath);
      const preparation = originalCoreManifest.galaxy?.modules?.find(module => module.path === 'Base.SC2Data/Generated/PreparationOptions.galaxy');
      if (!preparation) throw Error('项目缺少准备选项模块，不能自动迁移准备状态修复');
      if (preparation.beforeMissionStart && !['GameA_PreparationOptionsRestoreDifficultyAfterMissionInit','GameA_PreparationOptionsApplyAfterMissionInit'].includes(preparation.beforeMissionStart)) {
        throw Error('项目准备选项启动钩子已自行修改，不能自动迁移准备状态修复');
      }
      const migratedCoreManifest = structuredClone(originalCoreManifest);
      migratedCoreManifest.galaxy.modules.find(module => module.path === preparation.path).beforeMissionStart = 'GameA_PreparationOptionsApplyAfterMissionInit';
      await atomicFile(difficultyPath, await readFile(path.join(targetRoot, difficultyRelative)));
      await atomicJson(coreManifestPath, migratedCoreManifest);
    }
    if (Number(source.templateVersion) < 6 && Number(target.templateVersion) >= 6) {
      if (!originalCoreManifest) originalCoreManifest = await readJson(coreManifestPath);
      const currentCoreManifest = await readJson(coreManifestPath);
      const testMode = currentCoreManifest.galaxy?.modules?.find(module => module.path === 'Base.SC2Data/Generated/TestMode.galaxy');
      if (!testMode) throw Error('项目缺少测试模式模块，不能自动迁移启动生命周期修复');
      if (testMode.postMissionStart && testMode.postMissionStart !== 'GameA_TestModeApplyStartingEconomy') {
        throw Error('项目测试模式启动钩子已自行修改，不能自动迁移启动生命周期修复');
      }
      const migratedCoreManifest = structuredClone(currentCoreManifest);
      migratedCoreManifest.galaxy.modules.find(module => module.path === testMode.path).postMissionStart = 'GameA_TestModeApplyStartingEconomy';
      await atomicJson(coreManifestPath, migratedCoreManifest);
    }
    Object.assign(manifest, { templateId: target.templateId, templateVersion: target.templateVersion,
      templateHash: target.templateHash, dataBuild: target.dataBuild, runtimeContract: target.runtimeContract });
    await atomicJson(manifestPath, manifest);
    return await openProject(workspaceRoot, { appRoot });
  } catch (error) {
    if (originalDifficulty) await atomicFile(difficultyPath, originalDifficulty).catch(() => {});
    if (originalCoreManifest) await atomicJson(coreManifestPath, originalCoreManifest).catch(() => {});
    await atomicJson(manifestPath, originalManifest).catch(() => {});
    throw error;
  }
}
