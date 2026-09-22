import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const windows={skip:process.platform!=='win32'};
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function fixture(t){
  const base=mkdtempSync(path.join(tmpdir(),'coop-recovery-'));
  t.after(()=>{assert.equal(path.dirname(base),tmpdir());rmSync(base,{recursive:true,force:true});});
  const put=(relative,text='keep')=>{const file=path.join(base,relative);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text);return file;};
  return {base,put};
}
function ps(code,env=process.env){return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',"[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); " + code],{env,encoding:'utf8',timeout:15000,windowsHide:true});}

test('preflight lists every missing component before tool downloads',windows,t=>{
  const helper=quote(path.join(repo,'scripts/lib/setup-prerequisites.ps1'));
  const result=ps(`$ErrorActionPreference='Stop'; . ${helper}; function Get-Command {}; function Get-CoopVisualStudio {}; function Test-CoopWindowsSdk { $false }; Assert-CoopSetupPrerequisites`);
  assert.notEqual(result.status,0);
  for(const name of ['Python','Git','CMake','SDK'])assert.ok(result.stderr.includes(name),result.stderr);
});
test('SDK check requires both x64 libraries and headers; an incomplete install fails',windows,t=>{
  const f=fixture(t), sdk=path.join(f.base,'sdk');
  for(const file of ['Include/10.0/um/Windows.h','Include/10.0/ucrt/stdio.h','Lib/10.0/um/x64/kernel32.lib'])f.put(`sdk/${file}`);
  const check=()=>ps(`. ${quote(path.join(repo,'scripts/lib/setup-prerequisites.ps1'))}; Test-CoopWindowsSdk -KitsRoot ${quote(sdk)}`).stdout.trim();
  assert.equal(check(),'False'); f.put('sdk/Lib/10.0/ucrt/x64/ucrt.lib'); assert.equal(check(),'True');
});
function resetFixture(t){
  const f=fixture(t);
  for(const file of ['app/package.json','app/scripts/bootstrap.ps1','app/src-tauri/tauri.conf.json'])f.put(file,'{}');
  copyFileSync(path.join(repo,'scripts/reset-environment.ps1'),f.put('app/scripts/reset-environment.ps1',''));
  for(const file of ['app/.tools/cache','app/node_modules/cache','app/projects/A/coop-project.json','app/projects/A/game-a/core/modified.xml',
    'app/projects/A/.coopagent/session.json','app/projects/A/game-a/build/cache','app/.coopagent/projects.json','app/.coopagent/logs/app.log',
    'app/game-a/runtime/pending-job.json','app/outputs/report.md','shared/CoopAgent/database/coop.sqlite',
    'roaming/CoopAgent/opencode-models.json','roaming/CoopAgent/sc2-installation.json','outside/project.txt'])f.put(file);
  const env={...process.env,LOCALAPPDATA:path.join(f.base,'shared'),APPDATA:path.join(f.base,'roaming')};
  // No machine processes are stopped or inspected in this isolated deletion test.
  const run=(args='')=>ps(`$ErrorActionPreference='Stop'; function Get-CimInstance { @() }; & ${quote(path.join(f.base,'app/scripts/reset-environment.ps1'))} -Yes ${args}`,env);
  return {...f,run,has:relative=>existsSync(path.join(f.base,relative))};
}
test('default reset works for zip sources and keeps projects, jobs, logs and other copies data',windows,t=>{
  const f=resetFixture(t);
  symlinkSync(path.join(f.base,'outside'),path.join(f.base,'app/node_modules/external'),'junction');
  const result=f.run();assert.equal(result.status,0,result.stderr);
  for(const file of ['app/.tools','app/node_modules','app/projects/A/game-a/build'])assert.equal(f.has(file),false,file);
  for(const file of ['app/projects/A/game-a/core/modified.xml','app/projects/A/.coopagent/session.json','app/.coopagent/projects.json',
    'app/.coopagent/logs/app.log','app/game-a/runtime/pending-job.json','app/outputs/report.md','shared/CoopAgent/database/coop.sqlite',
    'roaming/CoopAgent/opencode-models.json','roaming/CoopAgent/sc2-installation.json','outside/project.txt'])assert.equal(f.has(file),true,file);
});
test('deleting projects and clearing shared data are separate explicit options',windows,t=>{
  const f=resetFixture(t);
  assert.equal(f.run('-DeleteProjects').status,0);
  assert.equal(f.has('app/projects'),false);assert.equal(f.has('app/.coopagent/projects.json'),false);
  assert.equal(f.has('shared/CoopAgent/database/coop.sqlite'),true);
  assert.equal(f.run('-ClearSharedData').status,0);
  assert.equal(f.has('shared/CoopAgent'),false);assert.equal(f.has('roaming/CoopAgent/sc2-installation.json'),false);
  assert.equal(f.has('roaming/CoopAgent/opencode-models.json'),true);assert.equal(f.has('outside/project.txt'),true);
});
test('reset cmd forwards explicit cleanup options while check mode leaves every file intact',windows,t=>{
  const f=resetFixture(t);
  copyFileSync(path.join(repo,'reset.cmd'),f.put('app/reset.cmd',''));
  const run=args=>spawnSync('cmd.exe',['/d','/c','reset.cmd','--check',...args],{
    cwd:path.join(f.base,'app'),encoding:'utf8',timeout:15000,windowsHide:true,
    env:{...process.env,LOCALAPPDATA:path.join(f.base,'shared'),APPDATA:path.join(f.base,'roaming')},
  });
  const targets=result=>{
    assert.equal(result.status,0,result.stdout+result.stderr);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('['),result.stdout.lastIndexOf(']')+1)).map(item=>item.Path);
  };
  const normal=targets(run([]));
  assert.ok(normal.includes(path.join(f.base,'app/.tools')));
  assert.ok(!normal.includes(path.join(f.base,'app/projects')));
  assert.ok(!normal.includes(path.join(f.base,'shared/CoopAgent')));
  const explicit=targets(run(['-DeleteProjects','-ClearSharedData']));
  assert.ok(explicit.includes(path.join(f.base,'app/projects')));
  assert.ok(explicit.includes(path.join(f.base,'shared/CoopAgent')));
  for(const file of ['app/.tools/cache','app/projects/A/coop-project.json','shared/CoopAgent/database/coop.sqlite'])assert.equal(f.has(file),true,file);
});

test('a redirected reset root is rejected before any cache or external file is deleted',windows,t=>{
  const f=resetFixture(t);
  rmSync(path.join(f.base,'app/.tools'),{recursive:true});symlinkSync(path.join(f.base,'outside'),path.join(f.base,'app/.tools'),'junction');
  const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/链接目录/);
  assert.equal(f.has('outside/project.txt'),true);assert.equal(f.has('app/node_modules/cache'),true);
});
