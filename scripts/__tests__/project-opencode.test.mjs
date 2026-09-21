import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_ROOT } from '../lib/project-context.mjs';
import { createProject } from '../lib/project-workspaces.mjs';

const executable = path.join(APP_ROOT, '.tools/opencode/bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
test('bundled OpenCode uses isolated data for create/list/export/delete; moving requires explicit session reassociation', { skip: !existsSync(executable), timeout: 60000 }, async t => {
  const root=await mkdtemp(path.join(tmpdir(),'coop-opencode-'));

  const a=await createProject({directory:path.join(root,'A'),name:'A'});
  const b=await createProject({directory:path.join(root,'B'),name:'B'});
  const env=project=>({...process.env,XDG_DATA_HOME:path.join(project,'.coopagent/opencode/data'),
    XDG_STATE_HOME:path.join(project,'.coopagent/opencode/state'),XDG_CACHE_HOME:path.join(project,'.coopagent/opencode/cache'),
    OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_CONFIG_CONTENT:'{}'});
  const server=spawn(executable,['serve','--hostname','127.0.0.1','--port','0'],{cwd:a.workspaceRoot,env:env(a.workspaceRoot),windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stderr.resume();
  t.after(async ()=>{ if(server.exitCode===null && server.signalCode===null) { const exited=new Promise(resolve=>server.once('exit',resolve)); server.kill(); await exited; } await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); });
  const address=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('OpenCode server did not start')),20000);
    server.once('error',e=>{clearTimeout(timeout);reject(e);});
    server.once('exit',()=>{clearTimeout(timeout);reject(Error('OpenCode server exited'));});
    let output='';server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timeout);resolve(match[0]);}});
  });
  const response=await fetch(`${address}/session?directory=${encodeURIComponent(a.workspaceRoot)}`,{signal:AbortSignal.timeout(15000),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Project A isolated session'})});
  assert.ok(response.ok);const session=await response.json();assert.ok(session.id);
  const cli=(project,args)=>{
    const result=spawnSync(executable,args,{cwd:project,env:env(project),windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  };
  assert.equal(cli(a.workspaceRoot,['session','list','--format','json'])[0].id,session.id);
  assert.deepEqual(cli(b.workspaceRoot,['session','list','--format','json']),[]);
  assert.equal(cli(a.workspaceRoot,['export',session.id]).info.id,session.id);
  const foreign=spawnSync(executable,['export',session.id],{cwd:b.workspaceRoot,env:env(b.workspaceRoot),windowsHide:true,encoding:'utf8',timeout:10000});
  assert.ok(foreign.status!==0 || !foreign.stdout.includes(session.id));
  server.kill();await new Promise(resolve=>server.once('exit',resolve));
  const moved=path.join(root,'moved');await rename(a.workspaceRoot,moved);
  const historical=cli(moved,['session','list','--format','json']);
  assert.equal(historical[0].id,session.id);
  assert.notEqual(path.resolve(historical[0].directory),path.resolve(moved));
  const deletion=spawnSync(executable,['session','delete',session.id],{cwd:moved,env:env(moved),windowsHide:true,encoding:'utf8',timeout:15000});
  assert.equal(deletion.status,0,deletion.stderr);
  assert.deepEqual(cli(moved,['session','list','--format','json']),[]);
});
