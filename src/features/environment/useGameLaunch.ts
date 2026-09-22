import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useProjectBridge } from '../projects/projectBridge';

export type EditorState = { editorRunning: boolean; gameRunning: boolean; documentOpen: boolean; documentModified: boolean };
type OpenedMap = { documentName: string; projectRevision: number; installation: string; manualStartRequired: boolean };
type Options = { gameReady: boolean; installation: string; projectRevision: number; busy: boolean; applying: boolean };

export function useGameLaunch({ gameReady, installation, projectRevision, busy, applying }: Options) {
  const { invoke } = useProjectBridge();
  const [opened, setOpened] = useState<OpenedMap | null>(null);
  const [processes, setProcesses] = useState<EditorState | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const launchingRef = useRef(false);
  const readSequence = useRef(0);
  const documentName = opened?.installation === installation ? opened.documentName : undefined;
  const refresh = useCallback(async () => {
    if (!isTauri() || !gameReady) return;
    const sequence = ++readSequence.current;
    try {
      const value = await invoke<EditorState>('game_a_editor_status', { documentName: documentName ?? null });
      if (sequence !== readSequence.current) return;
      setProcesses(value); setStatusError('');
    } catch {
      if (sequence !== readSequence.current) return;
      setProcesses(null); setStatusError('暂时无法确认编辑器状态；可重新准备并运行。');
    }
  }, [invoke, gameReady, documentName]);
  useEffect(() => {
    setProcesses(null);
    void refresh();
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(onVisible, 5000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      ++readSequence.current;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Readiness belongs to this project revision and the actual open document,
  // not to the lifetime of an editor process. Reloads start conservatively.
  const stale = Boolean(opened && (opened.projectRevision !== projectRevision || opened.installation !== installation));
  const ready = Boolean(opened && !stale && processes?.documentOpen && !processes.documentModified);
  async function launch() {
    if (!gameReady || busy || launchingRef.current || processes?.gameRunning) return;
    launchingRef.current = true; setLaunching(true); setError('');
    setOpened(null);
    try {
      const result = await invoke<{ editor: 'opened'; documentName: string; manualStartRequired: boolean }>('game_a_editor_launch');
      if (result.editor !== 'opened' || !result.documentName) throw Error('尚未确认最新地图已打开，请重试。');
      setOpened({ documentName: result.documentName, projectRevision, installation, manualStartRequired: result.manualStartRequired });
    } catch (reason) { setError(String(reason)); }
    finally { launchingRef.current = false; setLaunching(false); }
  }

  let label = '准备并运行', hint = '点击后会构建当前已写入的改动，并在编辑器中打开最新地图。';
  let state = 'idle';
  if (!gameReady) { label = '请先配置游戏路径'; hint = '配置星际争霸 II 安装目录后即可运行地图。'; }
  else if (launching) { label = '正在准备最新地图…'; hint = '正在构建并打开地图，请稍候。'; state = 'launching'; }
  else if (processes?.gameRunning) {
    label = '游戏运行中'; state = 'playing';
    hint = stale || applying ? '新改动不会进入当前对局。结束游戏后，请点击“更新并运行”。' : '结束游戏后可以再次运行；继续修改后，需要重新更新地图。';
  } else if (busy) { label = applying ? '正在写入修改…' : '等待当前任务完成'; hint = '任务结束后，再准备包含已写入改动的地图。'; }
  else if (error) { label = '重试准备并运行'; hint = '本次准备未完成，请处理下方问题后重试。'; state = 'error'; }
  else if (stale) { label = '更新并运行'; hint = '有新改动尚未载入编辑器。请先点击“更新并运行”，直接按 Ctrl+F9 仍会运行旧地图。'; state = 'stale'; }
  else if (processes?.documentModified) { label = '重新准备地图'; hint = '生成地图有未保存的编辑器改动，请先另存或关闭该文档，再返回这里重新准备。'; state = 'stale'; }
  else if (ready) {
    label = '运行最新地图'; state = 'ready';
    hint = opened?.manualStartRequired
      ? '最新地图已打开。请先处理编辑器弹窗，再在该地图中按 Ctrl+F9 运行。'
      : '最新地图已打开。若未自动进入游戏，请处理编辑器弹窗，再按 Ctrl+F9 运行。';
  } else if (processes?.editorRunning) {
    hint = '编辑器已打开。请点击此按钮，将当前项目的最新地图载入后再运行。';
  }
  return { label, hint, state, error, statusError, launch, refresh,
    disabled: !gameReady || launching || busy || Boolean(processes?.gameRunning) };
}
