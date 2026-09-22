import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { ErrorNotice } from './ErrorNotice';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));

test('errors keep technical details folded and open the fixed log directory only on request', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
  const error = 'EPERM: rename F:\\project\\temp -> F:\\project\\final\nstack frame';
  try {
    await act(async () => root.render(<ErrorNotice error={error} title="项目创建失败" hint="检查保存位置后重试。" />));
    expect(div.querySelector('strong')?.textContent).toBe('项目创建失败');
    expect(div.querySelector('details')?.open).toBe(false);
    expect(div.querySelector('pre')?.textContent).toBe(error);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce(undefined);
    await act(async () => div.querySelector('button')!.click());
    expect(invoke).toHaveBeenCalledExactlyOnceWith('open_log_directory');
    invoke.mockRejectedValueOnce(Error('permission denied'));
    await act(async () => div.querySelector('button')!.click());
    expect(div.querySelector('[role="status"]')?.textContent).toContain('.coopagent/logs');
  } finally { await act(async () => root.unmount()); div.remove(); }
});
