import { t, tx, useLanguage } from "../../i18n/index";
import { useEffect, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { activateProject, flushPreferences, ProjectContext, type Projects, type Project } from './projectBridge';
import './projects.css';
import { ErrorNotice, OpenLogsButton } from '../../components/common/ErrorNotice';
import { LanguageSelector } from '../../i18n/LanguageSelector';

export function ProjectShell({ children }: { children: ReactNode }) {
  useLanguage();
  const [projects, setProjects] = useState<Projects | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  async function load(next: Projects) {
    setError(next.recoveryNotice ?? '');
    let ui: Record<string,string> = {};
    if (next.active && !next.active.openError) {
      try { ui = await invoke<Record<string,string>>('project_ui', { project: next.active }); }
      catch(e) { setError(tx`项目已打开，但界面偏好读取失败：${String(e)}`); }
    }
    if (next.active?.openError) setError(next.active.openError);
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
    const selected = await open({ directory: true, multiple: false, title: t("打开 CoopAgent 项目") });
    if (typeof selected === 'string') await change('open', selected);
  }
  async function chooseParent() {
    const selected = await open({ directory: true, multiple: false, title: t("选择新项目的保存位置"), defaultPath: projects?.defaultDirectory });
    if (typeof selected === 'string') setDirectory(`${selected}/${name.trim() || t("新项目")}`);
  }
  if (!isTauri()) return <div className="project-shell">
    <header className="project-toolbar project-toolbar-preview"><LanguageSelector /></header>
    {children}
  </div>;
  return <div className="project-shell">
    <header className="project-toolbar">
      <LanguageSelector />
      <label>{t("项目 ")}<select aria-label={t("当前项目")} disabled={busy || !projects} value={projects?.active?.workspaceRoot ?? ''}
        onChange={e => void change('open', e.target.value)}>
        {!projects?.active && <option value="" disabled>{t("请选择项目")}</option>}
        {projects?.recent.map((p: Project) => <option key={p.projectId} value={p.workspaceRoot}>{p.name}</option>)}
      </select></label>
      <button disabled={busy || !projects} onClick={() => { setDialog('create'); setName(''); setDirectory(''); }}>{t("新建项目")}</button>
      <button disabled={busy || !projects} onClick={() => void chooseExisting()}>{t("打开项目")}</button>
      <button disabled={busy || !projects?.active} onClick={() => { setDialog('rename'); setName(projects?.active?.name ?? ''); }}>{t("重命名")}</button>
      {busy && <span>{t("正在切换…")}</span>}
      <OpenLogsButton />
      {!projects && error && <button onClick={() => { void invoke<Projects>('project_list').then(load).catch(e=>setError(String(e))); }}>{t("重试")}</button>}
    </header>
    {error && !dialog && <ErrorNotice error={error} title={t("项目操作遇到问题")} hint={t("请核对项目目录是否可用，重试或重新打开项目。")} />}
    {projects?.active && !projects.active.openError && <ProjectContext.Provider key={`${projects.active.projectId}:${projects.active.contextGeneration}`} value={projects.active}>{children}</ProjectContext.Provider>}
    {projects && !projects.active && <section className="project-welcome">
      <h1>{t("创建你的合作模式项目")}</h1>
      <p>{t("每个项目独立保存对话与修改，从原版合作模式配置开始。")}</p>
      <div><button onClick={() => { setDialog('create'); setName(''); setDirectory(''); }}>{t("新建项目")}</button>
        <button onClick={() => void chooseExisting()} disabled={busy}>{t("打开已有项目")}</button></div>
    </section>}
    {dialog && <div className="project-modal"><form onSubmit={e => { e.preventDefault(); void change(dialog); }}>
      <h2>{dialog === 'create' ? t("新建项目") : t("重命名项目")}</h2>
      <label>{t("名称")}<input autoFocus required maxLength={80} value={name} onChange={e=>setName(e.target.value)} /></label>
      {dialog === 'create' && <><p>{t("从默认地图运行层模板开始，独立保存修改与会话。")}</p>
        <label>{t("新项目目录")}<input value={directory} onChange={e=>setDirectory(e.target.value)} placeholder={`${projects?.defaultDirectory}/${name.trim() || t("新项目")}`} /></label>
        <button type="button" onClick={()=>void chooseParent()}>{t("选择保存位置")}</button></>}
      <div><button type="button" disabled={busy} onClick={()=>setDialog(null)}>{t("取消")}</button><button disabled={busy || !name.trim()} type="submit">{dialog === 'create' ? t("创建") : t("保存")}</button></div>
      {error && <ErrorNotice error={error} title={t("项目操作未完成")} hint={t("请核对名称和保存位置；若目录正被其他程序占用，请关闭占用后重试。")} />}
    </form></div>}
  </div>;
}
