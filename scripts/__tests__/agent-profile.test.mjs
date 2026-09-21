import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {buildAgentProfile,capabilityPolicy,parameterPolicy} from '../lib/agent-profile.mjs';

test('profile CLI uses the shared configuration without changing the default profile',async()=>{
  const base=JSON.parse(await fs.readFile('opencode.json','utf8'));
  assert.equal(buildAgentProfile(base).agent['coop-planner'].prompt,base.agent['coop-planner'].prompt);
  assert.match(await fs.readFile('runtime/coop-mcp/prompts/planner.md','utf8'),/coop-scalar-change/);
  assert.throws(()=>buildAgentProfile(base,{profile:'unknown'}),/Unknown Agent profile/);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'coop-profile-parity-'));
  try {
    for (const profile of ['workflow', 'capabilities', 'parameters']) {
      const output=path.join(root,`${profile}.json`);
      await promisify(execFile)(process.execPath,['scripts/agent-profile.mjs','--profile',profile,'--output',output],{windowsHide:true});
      const actual=JSON.parse(await fs.readFile(output,'utf8'));
      assert.deepEqual(actual,buildAgentProfile(base,{profile}));
      if(profile==='capabilities')assert.equal(actual.agent['coop-planner'].prompt,capabilityPolicy);
    }
    assert.equal(base.mcp.coop.environment?.COOPAGENT_TOOL_PROFILE,undefined);
    assert.deepEqual(JSON.parse(await fs.readFile('opencode.json','utf8')),base);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('parameter experiment replaces the model protocol rather than adding another write tool', async () => {
  const base=JSON.parse(await fs.readFile('opencode.json','utf8'));
  const config=buildAgentProfile(base,{profile:'parameters'}), agent=config.agent['coop-planner'];
  assert.equal(config.mcp.coop.environment.COOPAGENT_TOOL_PROFILE,'parameters');
  assert.equal(agent.prompt,parameterPolicy);
  assert.equal(agent.permission.coop_scalar_change,'allow');
  assert.equal(agent.permission['*'],'deny');
  for(const tool of ['coop_plan_prepare','coop_plan_submit','coop_change','coop_scalar_solve','bash','write','edit'])
    assert.notEqual(agent.permission[tool],'allow');
  assert.equal(agent.permission.skill,'deny');
  assert.equal(base.mcp.coop.environment?.COOPAGENT_TOOL_PROFILE,undefined);
});
