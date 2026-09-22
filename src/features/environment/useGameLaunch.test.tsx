import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useGameLaunch, type EditorState } from './useGameLaunch';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: bridge.invoke }));
let root: Root;
let container: HTMLDivElement;
let launch: ReturnType<typeof useGameLaunch>;
let options: Parameters<typeof useGameLaunch>[0];
let processes: EditorState;
let currentDocument: string;
let openedDocument: string;
function Harness() {
  launch = useGameLaunch(options);
  return <><p role="status">{launch.hint}</p><button disabled={launch.disabled} onClick={() => void launch.launch()}>{launch.label}</button></>;
}
async function render() { await act(async () => root.render(<Harness />)); }
async function refresh() { await act(async () => { window.dispatchEvent(new Event('focus')); }); }
async function run() { await act(async () => { container.querySelector('button')!.click(); }); }
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  options = { gameReady: true, installation: 'SC2', projectRevision: 0, busy: false, applying: false };
  processes = { editorRunning: false, gameRunning: false, documentOpen: false, documentModified: false };
  currentDocument = 'GameA-A-abcdef123456.SC2Map'; openedDocument = '';
  bridge.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'game_a_editor_status') return { ...processes, documentOpen: Boolean(args.documentName && args.documentName === openedDocument) };
    if (command === 'game_a_editor_launch') {
      openedDocument = currentDocument; processes.editorRunning = true;
      return { editor: 'opened', documentName: currentDocument, manualStartRequired: true };
    }
    throw Error(`Unexpected command: ${command}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
});

test('new writes after a game invalidate the map even though the editor remains open', async () => {
  await render(); expect(launch.label).toBe('准备并运行');
  await run(); expect(launch.state).toBe('ready'); expect(launch.label).toBe('运行最新地图'); expect(launch.hint).toContain('Ctrl+F9');
  expect(launch.hint).toContain('弹窗');
  processes.gameRunning = true; await refresh();
  expect(launch.label).toBe('游戏运行中'); expect(launch.disabled).toBe(true);
  processes.gameRunning = false; await refresh();
  expect(launch.state).toBe('ready'); expect(launch.disabled).toBe(false);
  options.projectRevision++; currentDocument = 'GameA-A-112233445566.SC2Map'; await render();
  expect(launch.label).toBe('更新并运行'); expect(launch.hint).toContain('旧地图');
  await run(); expect(launch.state).toBe('ready');
  expect(bridge.invoke).toHaveBeenLastCalledWith('game_a_editor_status', { documentName: currentDocument });
  // Writes during play also stay pending until this game ends and the map is rebuilt.
  processes.gameRunning = true; options.projectRevision++; await render(); await refresh();
  expect(launch.hint).toContain('新改动不会进入当前对局');
  processes.gameRunning = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(launch.label).toBe('更新并运行');
});

test('an unrelated/open/modified document and a failed launch never count as the latest map', async () => {
  processes.editorRunning = true; openedDocument = currentDocument;
  await render(); expect(launch.state).toBe('idle'); // Reload has no confirmation for this project.
  await run(); expect(launch.state).toBe('ready');
  openedDocument = 'Other.SC2Map'; await refresh(); expect(launch.state).toBe('idle');
  openedDocument = currentDocument; processes.documentModified = true; await refresh();
  expect(launch.state).toBe('stale'); expect(launch.hint).toContain('未保存');
  bridge.invoke.mockImplementation(async command => { throw Error(command === 'game_a_editor_launch' ? '地图构建失败' : '休眠断线'); });
  await run(); expect(launch.state).toBe('error'); expect(launch.error).toContain('地图构建失败');
});

test('work in progress blocks launching and a later revision cannot inherit an earlier launch result', async () => {
  options.busy = true; options.applying = true; await render();
  expect(launch.disabled).toBe(true); expect(launch.label).toBe('正在写入修改…');
  await run(); expect(bridge.invoke.mock.calls.every(call => call[0] !== 'game_a_editor_launch')).toBe(true);
  options.busy = false; options.applying = false; await render();
  let finish!: (value: unknown) => void;
  bridge.invoke.mockImplementation(command => command === 'game_a_editor_launch'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...processes, documentOpen: true }));
  await run(); expect(launch.state).toBe('launching'); expect(launch.disabled).toBe(true);
  options = { ...options, projectRevision: 1 }; await render();
  await act(async () => finish({ editor: 'opened', documentName: currentDocument, manualStartRequired: false }));
  expect(launch.label).toBe('更新并运行');
});

test('a status failure clears readiness and refocusing recovers without launching anything', async () => {
  await render(); await run(); expect(launch.state).toBe('ready');
  bridge.invoke.mockRejectedValueOnce(Error('休眠断线'));
  await refresh(); expect(launch.state).not.toBe('ready'); expect(launch.statusError).not.toBe('');
  await refresh(); expect(launch.state).toBe('ready'); expect(launch.statusError).toBe('');
  processes.editorRunning = false; openedDocument = ''; await refresh();
  expect(launch.state).toBe('idle');
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'game_a_editor_launch')).toHaveLength(1);
});
