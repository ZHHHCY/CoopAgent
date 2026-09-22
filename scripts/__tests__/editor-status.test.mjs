import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../game-a/scripts/editor-status.ps1', import.meta.url));
const quote = text => "'" + text.replaceAll("'", "''") + "'";

test('editor status distinguishes game presence and the exact generated document without starting applications', { skip: process.platform !== 'win32' }, () => {
  const document = 'GameA-Test-abcdef123456.SC2Map';
  for (const [title, game, expected] of [
    ['', false, [false, false, false, false]],
    ['StarCraft II Editor - Other.SC2Map', false, [true, false, false, false]],
    [`StarCraft II Editor - ${document}`, false, [true, false, true, false]],
    [`StarCraft II Editor - ${document}*`, true, [true, true, true, true]],
    ['', true, [false, true, false, false]],
  ]) {
    // Replace only this child's process query; no real editor or game is touched.
    const code = `function Get-Process { param($Name, $ErrorAction)
      if ($Name[0] -eq 'SC2Editor_x64' -and ${quote(title)} -ne '') { [pscustomobject]@{ MainWindowTitle = ${quote(title)} } }
      elseif ($Name[0] -eq 'SC2_x64' -and $${game}) { [pscustomobject]@{ MainWindowTitle = 'Game' } }
    }; & ${quote(script)} -DocumentName ${quote(document)}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.deepEqual([status.editorRunning, status.gameRunning, status.documentOpen, status.documentModified], expected);
  }
});
