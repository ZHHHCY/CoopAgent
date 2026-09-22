import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useSc2Environment, type Sc2InstallationStatus } from './useSc2Environment';
import { useAppliedChanges } from '../changes/useAppliedChanges';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
let root: Root, container: HTMLDivElement;
let environment: ReturnType<typeof useSc2Environment>, changes: ReturnType<typeof useAppliedChanges>;
let status: Sc2InstallationStatus;
function Probe() {
  environment = useSc2Environment();
  changes = useAppliedChanges({ agentReady: environment.agentReady, databaseBuild: environment.status?.databaseBuild,
    environmentRevision: environment.revision, databaseMessage: environment.status?.databaseStatus?.message });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  status = { configured:true,valid:true,databaseReady:false,checks:[],message:'game only',configPath:'fixture',
    databaseStatus:{ready:false,code:'database-missing',message:'数据库尚未构建'} };
  invoke.mockReset(); invoke.mockImplementation(async command => {
    if (command === 'sc2_installation_status') return status;
    if (command === 'change_summary_list') return {items:[]};
    throw new Error(command);
  });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
test('a valid game alone cannot trigger database queries; recheck unlocks them without restart', async () => {
  await act(async () => root.render(<Probe />));
  expect(environment.gameReady).toBe(true); expect(environment.agentReady).toBe(false);
  expect(invoke.mock.calls.some(([name]) => name === 'change_summary_list')).toBe(false);
  expect(changes.error).toContain('尚未构建');
  status = {...status,databaseReady:true,databaseBuild:'BTEST',databaseStatus:{ready:true,code:'ready',message:'ready'}};
  await act(async () => { await environment.refresh(); });
  expect(environment.agentReady).toBe(true); expect(changes.error).toBe('');
  expect(invoke.mock.calls.filter(([name])=>name==='change_summary_list')).toHaveLength(1);
});
test('history failure stays visible until an explicit same-build refresh succeeds', async () => {
  status={...status,databaseReady:true,databaseBuild:'BTEST',databaseStatus:{ready:true,code:'ready',message:'ready'}};
  let failed=true;
  invoke.mockImplementation(async command=>{
    if(command==='sc2_installation_status')return status;
    if(failed)throw Error('fixture query failure');
    return {items:[]};
  });
  await act(async()=>root.render(<Probe />));
  expect(changes.error).toBe('Error: fixture query failure');
  expect(invoke.mock.calls.filter(([name])=>name==='change_summary_list')).toHaveLength(1);
  failed=false;
  await act(async()=>{await environment.refresh();});
  expect(changes.error).toBe('');expect(environment.checking).toBe(false);
  expect(invoke.mock.calls.filter(([name])=>name==='change_summary_list')).toHaveLength(2);
});
