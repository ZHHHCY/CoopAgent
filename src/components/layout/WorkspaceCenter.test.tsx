import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { WorkspaceCenter } from './WorkspaceCenter';

const { invoke, bridge } = vi.hoisted(() => {
  const invoke = vi.fn();
  return { invoke, bridge: { invoke, storage: { getItem: () => null, setItem: vi.fn() } } };
});
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('../../features/projects/projectBridge', () => ({ useProjectBridge: () => bridge }));
vi.mock('../chat/ChatPanel', () => ({ ChatPanel: () => <textarea aria-label="聊天草稿" /> }));
vi.mock('../commander/CommanderDetailInspector', () => ({ CommanderDetailInspector: () => null }));
vi.mock('../commander/CommanderProgression', () => ({ CommanderProgression: () => null }));
vi.mock('../commander/CommanderRosterPanel', () => ({ CommanderRosterPanel: () => null }));
vi.mock('../commander/CommanderPicker', () => ({
  CommanderPicker: ({ onSelect, selectedCommanderId }: { onSelect: (id: string) => void; selectedCommanderId: string | null }) =>
    <button data-testid="commander" onClick={() => onSelect('ExampleCommander')}>{selectedCommanderId ?? '选择指挥官'}</button>,
}));

test('database loads on first visit, retains selection and chat draft, and refreshes applied changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => command === 'commander_list'
    ? { items: [{ id: 'ExampleCommander' }] } : { id: 'ExampleCommander' });
  const div = document.createElement('div');
  document.body.append(div);
  const root = createRoot(div);
  const props = {
    agent: { projectRevision: 0 }, environment: { agentReady: true, status: { rootPath: 'game-root' } },
  } as unknown as ComponentProps<typeof WorkspaceCenter>;
  const click = async (selector: string) => act(async () => div.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(async () => root.render(<WorkspaceCenter {...props} />));
    const draft = div.querySelector('textarea')!;
    draft.value = '尚未发送';
    expect(invoke).not.toHaveBeenCalled();
    props.agent = { ...props.agent, projectRevision: 1 };
    await act(async () => root.render(<WorkspaceCenter {...props} />));
    expect(invoke).not.toHaveBeenCalled();

    await click('#workspace-database-tab');
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['commander_list']);
    await click('[data-testid="commander"]');
    expect(invoke).toHaveBeenLastCalledWith('commander_get', { commanderId: 'ExampleCommander' });
    await click('#workspace-agent-tab');
    expect(div.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('尚未发送');
    await click('#workspace-database-tab');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(div.querySelector('[data-testid="commander"]')?.textContent).toBe('ExampleCommander');

    props.agent = { ...props.agent, projectRevision: 2 };
    await act(async () => root.render(<WorkspaceCenter {...props} />));
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['commander_list', 'commander_get', 'commander_list', 'commander_get']);
    await act(async () => root.render(<WorkspaceCenter key="new-project" {...props} />));
    expect(div.querySelector('[data-testid="commander"]')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(4);
    await click('#workspace-database-tab');
    expect(invoke).toHaveBeenCalledTimes(5);
    expect(div.querySelector('[data-testid="commander"]')?.textContent).toBe('选择指挥官');
  } finally {
    await act(async () => root.unmount());
    div.remove();
  }
});
