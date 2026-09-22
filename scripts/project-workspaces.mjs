import { createProject, openProject, openOrMigrateProject, legacyProject, renameProject, migrateProject, atomicJson } from './lib/project-workspaces.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { acquireGameALock, assertGameAReadable } from './lib/game-a-transaction.mjs';
import { createPlanSubmissionService } from './lib/plan-submission.mjs';
const [operation, argument, name] = process.argv.slice(2);
try {
  let result;
  if (operation === 'legacy') result = await legacyProject();
  else if (operation === 'create') result = await createProject({ directory: argument, name });
  else if (operation === 'open') result = await openOrMigrateProject(argument);
  else if (operation === 'rename') result = await renameProject(argument, name);
  else if (operation === 'migrate') result = await migrateProject(argument);
  else if (operation === 'idle') {
    const release = acquireGameALock(argument);
    try {
      assertGameAReadable(argument);
      if (createPlanSubmissionService({repoRoot: argument}).status().some(job => ['submitted','applying'].includes(job.state))) throw Error('项目仍有待完成提交，请等待恢复结束');
      result = { idle: true };
    } finally { release(); }
  }
  else if (operation === 'ui-read') {
    await openProject(argument);
    result = await readFile(path.join(argument, '.coopagent/ui.json'), 'utf8').then(JSON.parse).catch(error => { if(error.code==='ENOENT') return {}; throw error; });
  } else if (operation === 'ui-write') {
    await openProject(argument);
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    result = JSON.parse(data); await atomicJson(path.join(argument, '.coopagent/ui.json'), result);
  } else throw Error('Unknown project operation');
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
