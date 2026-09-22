import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../lib/desktop-app.ps1', import.meta.url));
const q = text => "'" + text.replaceAll("'", "''") + "'";
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
