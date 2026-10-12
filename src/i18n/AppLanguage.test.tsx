import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../App';
import { setLanguage, LANGUAGE_KEY } from './index';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), reveal: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke, Channel: class {} }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: mocks.reveal }));
const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const project = { projectId: 'example', name: '原项目名称', workspaceRoot: 'D:/projects/example', contextGeneration: 1 };
const session = { id: 'session-1', title: '新建项目', createdAtMs: 1000, updatedAtMs: 1000 };
const commander = { id: 'TerranRaynor', commanderObjectId: 'Raynor', nameZhCN: '雷诺', nameEnUS: 'Raynor', portraitDataUrl: pixel };
const unit = {
  techId: 'Marine', unitId: 'Marine', nameZhCN: '陆战队员', nameEnUS: 'Marine', iconDataUrl: pixel,
  stats: { unitId: 'Marine', lifeMax: 45, shieldMax: null, lifeArmor: 0, mineralCost: 50, vespeneCost: 0,
    supplyCost: 1, movementSpeed: 2.25, sight: 9, cargoSize: 1, attributes: ['Light', 'Biological'], buildTime: 25 },
};
let root: Root, container: HTMLDivElement;
let finishExport: (result: unknown) => void;
let emptyProject: boolean;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  localStorage.clear(); setLanguage('zh-CN');
  emptyProject = false;
  mocks.open.mockReset().mockResolvedValue('D:/exports'); mocks.reveal.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'project_list') return { active: emptyProject ? null : project, recent: emptyProject ? [] : [project], defaultDirectory: 'D:/projects' };
    if (command === 'project_ui') return args.value ? undefined : { 'coopagent-active-session-id': session.id };
    if (command === 'sc2_installation_status') return { configured: true, valid: true, databaseReady: true, databaseBuild: 'BTEST', rootPath: 'SC2', checks: [], message: 'StarCraft II 安装和合作模式数据库均已验证，可以使用 Agent。', configPath: 'config.json' };
    if (command === 'model_list') return { models: [{ selected: true, modelName: '我的模型', fullId: 'example/model' }] };
    if (command === 'agent_session_list') return [session];
    if (command === 'agent_session_read') return { ...session, historyTruncated: false, messages: [
      { id: 'user-original', role: 'user', text: '原始用户输入：新建项目' },
      { id: 'model-original', role: 'assistant', text: '生命值' },
    ], usage: { lastTurn: { input: 12, cached: 4, output: 3 }, total: { input: 120, cached: 40, output: 30 } } };
    if (command === 'agent_snapshot') return { busy: false, run: null };
    if (command === 'agent_task_status') return null;
    if (command === 'plan_submission_status') return [];
    if (command === 'change_summary_list') return { items: [] };
    if (command === 'game_a_editor_status') return { editorRunning: false, gameRunning: false, documentOpen: false, documentModified: false };
    if (command === 'commander_list') return { items: [commander] };
    if (command === 'commander_get') return { levelPerks: [], masteries: [], prestiges: [], roster: { units: [unit], buildings: [] }, panel: { abilities: [], summonedUnits: [] } };
    if (command === 'game_a_export') return new Promise(resolve => { finishExport = resolve; });
    throw Error(`Unexpected command: ${command}`);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
  setLanguage('zh-CN'); localStorage.clear();
});
async function flush() { await act(async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); }); }
async function click(selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); await flush(); }
async function choose(language: string) {
  await act(async () => {
    const selector = container.querySelector<HTMLSelectElement>('.language-selector select')!;
    selector.value = language; selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

test('language switching preserves chats and database selection, plus exports where supported, without new backend requests', async () => {
  await act(async () => root.render(<App />)); await flush();
  const draft = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, '未发送的草稿');
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
  expect(draft.value).toBe('未发送的草稿');
  await click('#workspace-database-tab'); await click('.commander-trigger'); await click('.commander-option');
  await click('.commander-roster-item');
  expect(container.querySelector('.database-workspace-detail')?.textContent).toContain('陆战队员');
  const hasExport = Boolean(container.querySelector('#workspace-export-tab'));
  if (hasExport) {
    await click('#workspace-export-tab'); await click('.map-export-primary');
    expect(container.querySelector<HTMLButtonElement>('.game-action-primary')!.disabled).toBe(true);
  }
  const callsBeforeSwitch = mocks.invoke.mock.calls.length;
  await choose('en-US');
  expect(mocks.invoke).toHaveBeenCalledTimes(callsBeforeSwitch);
  expect(document.documentElement.lang).toBe('en-US');
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en-US');
  expect(container.querySelector(hasExport ? '#workspace-export-tab' : '#workspace-database-tab')?.getAttribute('aria-selected')).toBe('true');
  if (hasExport) expect(container.querySelector('.map-export-primary')?.textContent).toContain('Exporting map project');
  expect(container.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('未发送的草稿');
  expect(container.querySelector('.message.user')?.textContent).toContain('原始用户输入：新建项目');
  expect(container.querySelector('.message.assistant')?.textContent).toContain('生命值');
  expect(container.querySelector('.current-session-card strong')?.textContent).toBe('新建项目');
  expect(container.querySelector('.selected-model-card strong')?.textContent).toBe('我的模型');
  expect(container.querySelector('.database-workspace-detail')?.textContent).toContain('Marine');
  expect(container.querySelector('.database-workspace-detail')?.textContent).toContain('Health45');
  expect(container.querySelector('.session-token-usage')?.textContent).toContain('120');
  if (hasExport) {
    await act(async () => finishExport({ status: 'exported', mapPath: 'D:/exports/原项目.SC2Map', componentPath: 'D:/exports/原项目.SC2Map/ComponentList.SC2Components' }));
    expect(container.querySelector('.map-export-result')?.textContent).toContain('D:/exports/原项目.SC2Map');
    expect(container.querySelector('.map-export-result')?.textContent).toContain('Latest export');
    expect(mocks.invoke.mock.calls.filter(call => call[0] === 'game_a_export')).toHaveLength(1);
  }
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'agent_start')).toBe(false);
  await choose('zh-CN');
  if (hasExport) expect(container.querySelector('.map-export-result')?.textContent).toContain('最近导出');
  expect(container.querySelector('.database-workspace-detail')?.textContent).toContain('陆战队员');
  expect(container.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('未发送的草稿');
});

test('language is selectable before a project exists without opening or changing a project', async () => {
  emptyProject = true;
  await act(async () => root.render(<App />)); await flush();
  const calls = mocks.invoke.mock.calls.length;
  await choose('en-US');
  expect(container.querySelector('.project-welcome h1')?.textContent).toBe('Create your Co-op project');
  expect(container.querySelector('.project-welcome')?.textContent).toContain('Open existing project');
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
});
