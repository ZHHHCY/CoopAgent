import { createContext, useContext, useMemo } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
export type Project = { projectId: string; name: string; workspaceRoot: string; contextGeneration: number; legacy?: boolean; openError?: string };
export type Projects = { active: Project; recent: Project[]; defaultDirectory: string };
export const ProjectContext = createContext<Project | null>(null);
let current: Project | null = null;
let preferences: Record<string, string> = {};
let writes = Promise.resolve();
export function activateProject(project: Project, ui: Record<string,string>) { current = project; preferences = ui; }
export function useProjectBridge() {
  const project = useContext(ProjectContext);
  return useMemo(() => {
    const valid = () => !project || (current?.projectId === project.projectId && current?.contextGeneration === project.contextGeneration);
    const token = project && { projectId: project.projectId, contextGeneration: project.contextGeneration };
    const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (!valid()) throw Error('项目已切换');
      const result = await tauriInvoke<T>(command, token ? { ...args, project: token } : args);
      if (!valid()) throw Error('项目已切换');
      return result;
    };
    const persist = () => {
      if (!token || !valid()) return;
      const value = { ...preferences };
      writes = writes.catch(() => {}).then(() => tauriInvoke<void>('project_ui', { project: token, value }));
      // Callers can await flushPreferences before switching; surface failures there.
      void writes.catch(() => {});
    };
    const storage = {
      getItem: (key: string) => project ? (valid() ? preferences[key] ?? (project.legacy ? localStorage.getItem(key) : null) : null) : localStorage.getItem(key),
      setItem: (key: string, value: string) => { if (!project) localStorage.setItem(key, value); else if (valid()) { preferences[key] = value; persist(); } },
      removeItem: (key: string) => { if (!project) localStorage.removeItem(key); else if (valid()) { delete preferences[key]; if(project.legacy) localStorage.removeItem(key); persist(); } },
    };
    return { invoke, storage, project, valid };
  }, [project]);
}
export function flushPreferences() { return writes; }
