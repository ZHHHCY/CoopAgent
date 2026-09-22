import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ProjectShell } from './ProjectShell';
const { invoke, open } = vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open}));
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  invoke.mockReset();open.mockReset();
});
afterEach(()=>{act(()=>root.unmount());container.remove();});
test.each([undefined,'项目列表无法读取，已备份到 fixture。'])('an empty or recovered registry can open an existing project: %s',async notice=>{
  const active={projectId:'A',name:'My project',workspaceRoot:'F:/fixture',contextGeneration:2};
  invoke.mockImplementation(async name=>{
    if(name==='project_list')return {active:null,recent:[],defaultDirectory:'F:/projects',recoveryNotice:notice};
    if(name==='project_change')return {active,recent:[active],defaultDirectory:'F:/projects'};
    return {};
  });
  open.mockResolvedValue('F:/fixture');
  await act(async()=>root.render(<ProjectShell><div>workspace content</div></ProjectShell>));
  expect(container.textContent).toContain('创建你的合作模式项目');
  expect(container.textContent).not.toContain('workspace content');
  if(notice)expect(container.textContent).toContain(notice);
  await act(async()=>{[...container.querySelectorAll('button')].find(button=>button.textContent==='打开已有项目')!.click();});
  expect(invoke).toHaveBeenCalledWith('project_change',expect.objectContaining({operation:'open',directory:'F:/fixture',project:null}));
  expect(container.textContent).toContain('workspace content');
  if(notice)expect(container.textContent).not.toContain(notice);
});
