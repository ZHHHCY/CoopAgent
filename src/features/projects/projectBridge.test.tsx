import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { activateProject, flushPreferences, ProjectContext, useProjectBridge, type Project } from './projectBridge';

const bridge=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:bridge.invoke}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let current: ReturnType<typeof useProjectBridge>;
function Probe(){current=useProjectBridge();return null;}
const a:Project={projectId:'A',contextGeneration:1,name:'A',workspaceRoot:'/A'};
const b:Project={projectId:'B',contextGeneration:2,name:'B',workspaceRoot:'/B'};
beforeEach(()=>{bridge.invoke.mockReset().mockResolvedValue({});container=document.createElement('div');root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());});
async function mount(project:Project,ui:Record<string,string>={}){
  activateProject(project,ui);
  await act(async()=>root.render(<ProjectContext.Provider key={project.projectId} value={project}><Probe /></ProjectContext.Provider>));
}
test('every project operation carries captured identity and generation; late responses cannot cross projects',async()=>{
  await mount(a);
  let finish!:(value:unknown)=>void;
  bridge.invoke.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=current.invoke('commander_get',{commanderId:'Swann'});
  const rejected=expect(pending).rejects.toThrow('项目已切换');
  expect(bridge.invoke).toHaveBeenCalledWith('commander_get',{commanderId:'Swann',project:{projectId:'A',contextGeneration:1}});
  const old=current;
  await mount(b);
  finish({name:'A data'});await rejected;
  await expect(old.invoke('plan_submission_retry',{preparationId:'A-prep'})).rejects.toThrow('项目已切换');
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
test('drafts and session preferences are scoped and late old callbacks cannot persist into B',async()=>{
  await mount(a,{draft:'A draft', 'coopagent-active-session-id':'session-A'});
  expect(current.storage.getItem('draft')).toBe('A draft');
  const old=current;
  current.storage.setItem('draft','updated A');await flushPreferences();
  expect(bridge.invoke).toHaveBeenCalledWith('project_ui',{project:{projectId:'A',contextGeneration:1},value:{draft:'updated A','coopagent-active-session-id':'session-A'}});
  await mount(b,{draft:'B draft'});
  old.storage.setItem('draft','late A');
  expect(current.storage.getItem('draft')).toBe('B draft');
  expect(current.storage.getItem('coopagent-active-session-id')).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
