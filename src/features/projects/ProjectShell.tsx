import { useEffect, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { activateProject, flushPreferences, ProjectContext, type Projects, type Project } from './projectBridge';
import './projects.css';

export function ProjectShell({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Projects | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  async function load(next: Projects) {
    let ui: Record<string,string> = {};
    if (!next.active.openError) {
      try { ui = await invoke<Record<string,string>>('project_ui', { project: next.active }); }
      catch(e) { setError(`项目已打开，但界面偏好读取失败：${String(e)}`); }
    }
    if (next.active.openError) setError(next.active.openError);
    activateProject(next.active, ui);
    setProjects(next);
  }
  useEffect(() => {
    if (isTauri()) void invoke<Projects>('project_list').then(load).catch(e => setError(String(e)));
  }, []);
  async function change(operation: string, target?: string) {
    if (!projects || busy) return;
    setBusy(true); setError('');
    try {
      await flushPreferences();
      const next = await invoke<Projects>('project_change', { operation, directory: target ?? (directory || `${projects.defaultDirectory}/${name.trim().replace(/[<>:"/\\|?*]/g, '-')}`), name, project: projects.active });
      await load(next); setDialog(null);
    } catch(e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function chooseExisting() {
    const selected = await open({ directory: true, multiple: false, title: '打开 CoopAgent 项目' });
    if (typeof selected === 'string') await change('open', selected);
  }
  async function chooseParent() {
    const selected = await open({ directory: true, multiple: false, title: '选择新项目的保存位置', defaultPath: projects?.defaultDirectory });
    if (typeof selected === 'string') setDirectory(`${selected}/${name.trim() || '新项目'}`);
  }
  if (!isTauri()) return children;
  return <div className="project-shell">
    <header className="project-toolbar">
      <label>项目 <select aria-label="当前项目" disabled={busy || !projects} value={projects?.active.workspaceRoot ?? ''}
        onChange={e => void change('open', e.target.value)}>
        {projects?.recent.map((p: Project) => <option key={p.projectId} value={p.workspaceRoot}>{p.name}</option>)}
      </select></label>
      <button disabled={busy || !projects} onClick={() => { setDialog('create'); setName(''); setDirectory(''); }}>新建项目</button>
      <button disabled={busy || !projects} onClick={() => void chooseExisting()}>打开项目</button>
      <button disabled={busy || !projects} onClick={() => { setDialog('rename'); setName(projects?.active.name ?? ''); }}>重命名</button>
      {busy && <span>正在切换…</span>}
      {error && <span role="alert">{error}</span>}
      {!projects && error && <button onClick={() => { void invoke<Projects>('project_list').then(load).catch(e=>setError(String(e))); }}>重试</button>}
    </header>
    {projects && !projects.active.openError && <ProjectContext.Provider key={`${projects.active.projectId}:${projects.active.contextGeneration}`} value={projects.active}>{children}</ProjectContext.Provider>}
    {dialog && <div className="project-modal"><form onSubmit={e => { e.preventDefault(); void change(dialog); }}>
      <h2>{dialog === 'create' ? '新建项目' : '重命名项目'}</h2>
      <label>名称<input autoFocus required maxLength={80} value={name} onChange={e=>setName(e.target.value)} /></label>
      {dialog === 'create' && <><p>从默认 Game A 模板开始，独立保存修改与会话。</p>
        <label>新项目目录<input value={directory} onChange={e=>setDirectory(e.target.value)} placeholder={`${projects?.defaultDirectory}/${name.trim() || '新项目'}`} /></label>
        <button type="button" onClick={()=>void chooseParent()}>选择保存位置</button></>}
      <div><button type="button" disabled={busy} onClick={()=>setDialog(null)}>取消</button><button disabled={busy || !name.trim()} type="submit">{dialog === 'create' ? '创建' : '保存'}</button></div>
      {error && <p role="alert">{error}</p>}
    </form></div>}
  </div>;
}
