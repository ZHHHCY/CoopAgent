import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const windows = { skip: process.platform !== 'win32' };
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'coop-sc2-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, '游戏安装 StarCraft II');
  for (const dir of ['SC2Data/data', 'SC2Data/indices', 'Versions/Base97579']) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ['.build.info', 'StarCraft II.exe', 'StarCraft II Editor_x64.exe', 'Versions/Base97579/SC2_x64.exe']) await writeFile(path.join(root, file), 'fixture');
  return { base, root, config: path.join(base, 'config/CoopAgent/sc2-installation.json'), env: { ...process.env, APPDATA: path.join(base, 'config'), COOPAGENT_SC2_ROOT: '' } };
}
function run(f, script, args = []) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env: f.env, encoding: 'utf8', timeout: 30000 });
}
const configure = path.join(repo, 'scripts/configure-sc2.ps1');

test('setup persists folder or nested executable to the desktop config and reuses the choice', windows, async t => {
  const f = await fixture(t);
  for (const selected of [f.root, path.join(f.root, 'Versions/Base97579/SC2_x64.exe'), path.join(f.root, 'StarCraft II.exe')]) {
    const result = run(f, configure, ['-StarCraftRoot', selected, '-NonInteractive']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), { rootPath: f.root });
  }
  assert.equal(run(f, configure, ['-NonInteractive']).status, 0);
  const helper = path.join(repo, 'scripts/lib/sc2-installation.ps1');
  const reader = path.join(f.base, 'read-saved.ps1');
  await writeFile(reader, `. '${helper.replaceAll("'", "''")}'; [IO.File]::WriteAllText('${path.join(f.base, 'read.txt').replaceAll("'", "''")}', (Get-CoopSc2SavedRoot))`);
  assert.equal(run(f, reader).status, 0);
  assert.equal(await readFile(path.join(f.base, 'read.txt'), 'utf8'), f.root);
});

test('invalid selection does not replace a valid saved installation; missing config cannot silently pass', windows, async t => {
  const f = await fixture(t);
  assert.notEqual(run(f, configure, ['-NonInteractive']).status, 0);
  assert.equal(run(f, configure, ['-StarCraftRoot', f.root, '-NonInteractive']).status, 0);
  const saved = await readFile(f.config, 'utf8');
  await rm(path.join(f.root, 'SC2Data/indices'), { recursive: true });
  for (const args of [['-StarCraftRoot', f.root, '-NonInteractive'], ['-NonInteractive']]) {
    assert.notEqual(run(f, configure, args).status, 0);
    assert.equal(await readFile(f.config, 'utf8'), saved);
  }
});

test('preparation uses the selected install and this extraction; bootstrap failure stops downstream work', windows, async t => {
  const f = await fixture(t);
  const scripts = path.join(f.base, 'scripts');
  await mkdir(path.join(scripts, 'lib'), { recursive: true });
  for (const file of ['configure-sc2.ps1', 'prepare-coopagent.ps1', 'lib/sc2-installation.ps1', 'lib/process-log.ps1']) await cp(path.join(repo, 'scripts', file), path.join(scripts, file));
  await writeFile(path.join(scripts, 'lib/setup-prerequisites.ps1'), 'function Assert-CoopSetupPrerequisites {}');
  await writeFile(path.join(scripts, 'bootstrap.cmd'), '@exit /b 0\r\n');
  await writeFile(path.join(scripts, 'casc-inspect.ps1'), `param([string]$StarCraftRoot,[switch]$NoOpen)
if ($StarCraftRoot -ne $env:COOPAGENT_SC2_ROOT) { throw 'Wrong installation' }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'observed-root.txt'), $StarCraftRoot)
$output = Join-Path $PSScriptRoot 'chosen-extraction'
[IO.Directory]::CreateDirectory($output) | Out-Null
[IO.File]::WriteAllText((Join-Path $output 'manifest.json'), '{}')
Write-Output 'extraction progress'
Write-Output $output
`);
  await writeFile(path.join(scripts, 'casc-database.cmd'), '@echo %*> "%~dp0database-args.txt"\r\n@exit /b 0\r\n');
  const prepare = path.join(scripts, 'prepare-coopagent.ps1');
  const success = run(f, prepare, ['-StarCraftRoot', f.root]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(await readFile(path.join(scripts, 'observed-root.txt'), 'utf8'), f.root);
  const args = await readFile(path.join(scripts, 'database-args.txt'), 'utf8');
  assert.ok(args.includes('build --casc-root'));
  assert.ok(args.includes(path.join(scripts, 'chosen-extraction')));
  const setupLogs = (await readdir(path.join(f.base, '.coopagent/logs'))).filter(name => /^setup-.*\.log$/.test(name));
  assert.equal(setupLogs.length, 1);
  assert.match(await readFile(path.join(f.base, '.coopagent/logs', setupLogs[0]), 'utf8'), /退出代码：0/);
  await rm(path.join(scripts, 'observed-root.txt'));
  await rm(path.join(scripts, 'database-args.txt'));
  await writeFile(path.join(scripts, 'bootstrap.cmd'), '@echo BOOTSTRAP-STDOUT\r\n@echo BOOTSTRAP-STDERR 1>&2\r\n@exit /b 7\r\n');
  const failed = run(f, prepare, ['-StarCraftRoot', f.root]);
  assert.notEqual(failed.status, 0);
  assert.ok(failed.stderr.includes('工具链准备失败（退出代码 7）'), failed.stderr);
  const failureLogNames = (await readdir(path.join(f.base, '.coopagent/logs'))).filter(name => !setupLogs.includes(name));
  assert.equal(failureLogNames.length, 1);
  const failureLog = await readFile(path.join(f.base, '.coopagent/logs', failureLogNames[0]), 'utf8');
  for (const text of ['BOOTSTRAP-STDOUT', 'BOOTSTRAP-STDERR', '工具链准备失败', '退出代码：1']) assert.ok(failureLog.includes(text), failureLog);
  await assert.rejects(readFile(path.join(scripts, 'observed-root.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(scripts, 'database-args.txt')), { code: 'ENOENT' });
  await writeFile(path.join(scripts, 'bootstrap.cmd'), '@exit /b 0\r\n');
  for (const stage of ['EXTRACTION', 'CASC-BUILD']) {
    const beforeLogs = await readdir(path.join(f.base, '.coopagent/logs'));
    if (stage === 'EXTRACTION') {
      await writeFile(path.join(scripts, 'casc-inspect.ps1'), "param([string]$StarCraftRoot,[switch]$NoOpen)\nWrite-Output 'EXTRACTION-PROGRESS'; throw 'EXTRACTION-FAILED'");
    } else {
      await cp(path.join(repo, 'scripts/casc-inspect.ps1'), path.join(scripts, 'casc-inspect.ps1'));
      await writeFile(path.join(scripts, 'casc-bootstrap.ps1'), "Write-Output 'CASC-BUILD-PROGRESS'; throw 'CASC-BUILD-FAILED'");
    }
    const result = run(f, prepare, ['-StarCraftRoot', f.root]);
    assert.notEqual(result.status, 0);
    const logNames = (await readdir(path.join(f.base, '.coopagent/logs'))).filter(name => !beforeLogs.includes(name));
    assert.equal(logNames.length, 1);
    const log = await readFile(path.join(f.base, '.coopagent/logs', logNames[0]), 'utf8');
    for (const text of [`${stage}-PROGRESS`, `${stage}-FAILED`, '退出代码：1']) assert.ok(log.includes(text), log);
    await assert.rejects(readFile(path.join(scripts, 'database-args.txt')), { code: 'ENOENT' });
  }
});

test('launcher captures native stderr and exit status before the app exists', windows, async t => {
  const f = await fixture(t), scripts = path.join(f.base, "有 空格 & O'Neil", 'scripts');
  await mkdir(path.join(scripts, 'lib'), {recursive:true});
  for (const file of ['start-coopagent.ps1', 'lib/process-log.ps1', 'lib/desktop-app.ps1']) await cp(path.join(repo, 'scripts', file), path.join(scripts, file));
  await writeFile(path.join(scripts, 'build.cmd'), '@echo COMPILER-OUTPUT\r\n@echo LINK-FAILED 1>&2\r\n@exit /b 9\r\n');
  const result = run(f, path.join(scripts, 'start-coopagent.ps1'));
  assert.equal(result.status, 1, result.stderr);
  const logDir = path.join(scripts, '../.coopagent/logs');
  const log = await readFile(path.join(logDir, (await readdir(logDir))[0]), 'utf8');
  // The launcher fails with 1 and retains the original build exit code in its diagnosis.
  for (const text of ['COMPILER-OUTPUT', 'LINK-FAILED', '退出代码：9', '退出代码：1']) assert.ok(log.includes(text), log);
});

test('standalone CASC inspection reads the shared config and respects explicit and environment overrides', windows, async t => {
  const f = await fixture(t);
  const saved = path.join(f.base, 'saved-missing');
  const environment = path.join(f.base, 'environment-missing');
  const explicit = path.join(f.base, 'explicit-missing');
  await mkdir(path.dirname(f.config), { recursive: true });
  await writeFile(f.config, JSON.stringify({ rootPath: saved }));
  const inspect = path.join(repo, 'scripts/casc-inspect.ps1');
  for (const [override, args, expected] of [
    ['', [], saved],
    [environment, [], environment],
    [environment, ['-StarCraftRoot', explicit], explicit],
  ]) {
    // Missing folders stop before tool installation or data extraction.
    f.env.COOPAGENT_SC2_ROOT = override;
    const result = run(f, inspect, [...args, '-NoOpen']);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(expected), result.stderr);
  }
});
