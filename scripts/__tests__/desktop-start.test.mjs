import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../lib/desktop-app.ps1', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const q = text => "'" + text.replaceAll("'", "''") + "'";

test('batch entrypoints preserve UTF-8 without BOM and Windows line endings', () => {
  const files = ['setup.cmd', 'start.cmd', 'reset.cmd',
    ...readdirSync(path.join(repo, 'scripts'), { recursive: true })
      .filter(file => /\.(?:bat|cmd)$/i.test(file)).map(file => path.join('scripts', file))];
  for (const file of files) {
    const bytes = readFileSync(path.join(repo, file));
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', `${file}: cmd.exe does not accept a UTF-8 BOM`);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.doesNotMatch(text, /(?<!\r)\n|\r(?!\n)/, `${file}: use CRLF for cmd.exe`);
  }
});

test('Git stores and archives CRLF batch bytes with Windows, macOS and Linux autocrlf settings', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'coop git-eol-'));
  t.after(() => { assert.equal(path.dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: base, timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
    return result.stdout;
  };
  git('init', '--quiet');
  copyFileSync(path.join(repo, '.gitattributes'), path.join(base, '.gitattributes'));
  const batch = readFileSync(path.join(repo, 'start.cmd'));
  const document = Buffer.from('# Guide\n\nDocument maintenance.\n');
  writeFileSync(path.join(base, 'start.cmd'), batch);
  writeFileSync(path.join(base, 'guide.md'), document);
  for (const setting of ['true', 'input', 'false']) {
    git('config', 'core.autocrlf', setting);
    git('add', '--renormalize', '.');
    git('add', '--', '.gitattributes', 'start.cmd', 'guide.md');
    assert.deepEqual(git('show', ':start.cmd'), batch, `stored batch: autocrlf=${setting}`);
    assert.deepEqual(git('show', ':guide.md'), document, `stored document: autocrlf=${setting}`);
    const checkout = path.join(base, `checkout-${setting}`);
    mkdirSync(checkout);
    git('checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`);
    assert.deepEqual(readFileSync(path.join(checkout, 'start.cmd')), batch, `checked-out batch: autocrlf=${setting}`);
    assert.deepEqual(readFileSync(path.join(checkout, 'guide.md')), document, `checked-out document: autocrlf=${setting}`);
  }
  const tree = git('write-tree').toString().trim();
  const archive = git('archive', '--format=tar', tree, 'start.cmd');
  assert.equal(archive.subarray(0, 100).toString().replace(/\0.*$/s, ''), 'start.cmd');
  assert.deepEqual(archive.subarray(512, 512 + batch.length), batch, 'archive preserves actual CRLF bytes');

  writeFileSync(path.join(base, 'start.cmd'), batch.toString('utf8').replaceAll('\r\n', '\n'));
  assert.equal(git('diff', '--name-only', '--', 'start.cmd').toString().trim(), 'start.cmd', 'an accidental LF conversion is now a visible Git change');
});

test('real batch launchers parse Chinese text, quoted paths and success/failure exits', { skip: process.platform !== 'win32' }, t => {
  const base = mkdtempSync(path.join(tmpdir(), 'coop launch-'));
  t.after(() => { assert.equal(path.dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const root = path.join(base, '中文 项目');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const file of ['start.cmd', 'setup.cmd']) copyFileSync(path.join(repo, file), path.join(root, file));
  const run = (file, ...args) => spawnSync('cmd.exe', ['/d', '/c', file, ...args], {
    cwd: root, encoding: 'utf8', input: '\r\n', timeout: 15000, windowsHide: true,
  });
  const check = (result, status, message) => {
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(result.stderr, '', result.stderr);
    assert.ok(result.stdout.includes(message), result.stdout);
  };
  check(run('start.cmd', '--check'), 0, 'CoopAgent 启动器检查通过。');

  // Isolated workers never build, launch, download or touch the user's environment.
  writeFileSync(path.join(root, 'scripts/start-coopagent.ps1'), 'exit 7\r\n');
  check(run('start.cmd'), 7, 'CoopAgent 启动失败，退出代码：7');
  writeFileSync(path.join(root, 'scripts/start-coopagent.ps1'), 'exit 0\r\n');
  check(run('start.cmd'), 0, '正在启动 CoopAgent');
  writeFileSync(path.join(root, 'scripts/prepare-coopagent.ps1'), 'exit 9\r\n');
  check(run('setup.cmd'), 9, 'CoopAgent 环境准备失败，退出代码：9');
  writeFileSync(path.join(root, 'scripts/prepare-coopagent.ps1'), 'exit 0\r\n');
  check(run('setup.cmd'), 0, 'CoopAgent 环境准备完成。');
});

test('daily startup reuses a desktop exe; missing/failed builds are handled without starting dev servers', { skip: process.platform !== 'win32' }, t => {
  const base = mkdtempSync(path.join(tmpdir(), 'coop desktop-'));
  t.after(() => { assert.equal(path.dirname(base), tmpdir()); rmSync(base, { recursive: true, force: true }); });
  const exe = path.join(base, 'src-tauri/target/release/coopagent.exe');
  mkdirSync(path.dirname(exe), { recursive: true }); mkdirSync(path.join(base, 'scripts'));
  const build = (status) => writeFileSync(path.join(base, 'scripts/build.cmd'), `@echo off\r\necho built>"%~dp0..\\built"\r\n${status === 0 ? 'echo exe>"%~dp0..\\src-tauri\\target\\release\\coopagent.exe"\r\n' : ''}exit /b ${status}\r\n`);
  const launch = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); . ${q(helper)}; function Start-Process { param($FilePath,$WorkingDirectory,$ErrorAction) [IO.File]::WriteAllText(${q(path.join(base, 'launched'))}, $FilePath + '|' + $WorkingDirectory) }; Start-CoopDesktop -Root ${q(base)}`],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  build(0); writeFileSync(exe, 'existing');
  let result = launch(); assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(path.join(base, 'built')), false);
  assert.ok(existsSync(path.join(base, 'launched')));
  rmSync(exe); rmSync(path.join(base, 'launched'));
  build(1); result = launch(); assert.notEqual(result.status, 0); assert.equal(existsSync(path.join(base, 'launched')), false);
  build(0); result = launch(); assert.equal(result.status, 0, result.stderr); assert.ok(existsSync(path.join(base, 'launched')));
});
