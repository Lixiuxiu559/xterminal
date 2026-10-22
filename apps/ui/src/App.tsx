import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppSession, Bootstrap, DesktopBridge, ProjectRecord } from '../../../packages/protocol/src/desktop';
import type { EngineKind } from '../../../packages/protocol/src/index';
import { Icon } from './icons';
import { sessionStateName } from './sessionState';
import { defaultSessionTitle, MAX_TITLE_LENGTH, titleError, ownsSessionControl } from './uiValidation';

const LanPanel = lazy(() => import('./LanPanel').then(module => ({ default: module.LanPanel })));
const AgentPane = lazy(() => import('./AgentPane').then(module => ({ default: module.AgentPane })));
const TerminalPane = lazy(() => import('./TerminalPane').then(module => ({ default: module.TerminalPane })));

declare global { interface Window { xterminal?: DesktopBridge } }
const engineNames: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };
const engineIcons: Record<EngineKind, string> = { claude: 'spark', codex: 'code', shell: 'terminal' };
const explain = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试。';

export function App({ client }: { client?: DesktopBridge } = {}) {
  const bridge = client ?? window.xterminal;
  const [catalog, setCatalog] = useState<Bootstrap | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(!!bridge);
  const [online, setOnline] = useState(!!bridge);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('xterminal-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  const [projectId, setProjectId] = useState('');
  const [engine, setEngine] = useState<EngineKind>('shell');
  const [title, setTitle] = useState('');
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [showLan, setShowLan] = useState(false);
  const createDialog = useRef<HTMLDialogElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  const mobileNav = useRef<HTMLDialogElement>(null);
  const mobileInfo = useRef<HTMLDialogElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const latestCatalog = useRef(catalog);
  latestCatalog.current = catalog;
  const current = catalog?.sessions.find(session => session.id === selected);
  const project = catalog?.projects.find(project => project.id === current?.projectId);
  const canControl = ownsSessionControl(current, bridge?.principalId ?? 'desktop');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#19211d' : '#fafbf8');
    try { localStorage.setItem('xterminal-theme', theme); } catch { /* Preference storage may be disabled. */ }
  }, [theme]);
  useEffect(() => {
    const resize = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
    resize(); window.visualViewport?.addEventListener('resize', resize);
    return () => window.visualViewport?.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = bridge.onEvent(event => {
      if (disposed) return;
      if (event.type === 'catalog.changed') { receivedEvent = true; setCatalog(event.snapshot); setOnline(true); setError(''); }
      if (event.type === 'host.offline') { setOnline(false); setError(event.message || '与此电脑的连接已断开。'); }
    });
    bridge.invoke('bootstrap', {}).then(snapshot => {
      if (!disposed && !receivedEvent) { setCatalog(snapshot); setOnline(true); }
    }).catch(err => { if (!disposed) { setError(explain(err)); setOnline(false); } }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    if (!catalog) return;
    setSelected(value => catalog.sessions.some(session => session.id === value) ? value : catalog.sessions[0]?.id ?? '');
  }, [catalog]);

  function openCreate() {
    mobileNav.current?.close();
    setFormError(''); setTitle(''); setEngine('shell');
    setProjectId(current?.projectId ?? latestCatalog.current?.projects[0]?.id ?? '');
    createDialog.current?.showModal();
  }
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]') || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'n' && bridge && online) { event.preventDefault(); openCreate(); }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault(); setNavCollapsed(false);
        if (window.matchMedia('(max-width: 760px)').matches) {
          mobileNav.current?.showModal();
          mobileNav.current?.querySelector('input')?.focus();
        } else requestAnimationFrame(() => searchField.current?.focus());
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [current?.projectId, bridge, online]);

  async function refresh() {
    if (!bridge) return;
    setLoading(true); setError('');
    try { setCatalog(await bridge.invoke('bootstrap', {})); setOnline(true); }
    catch (err) { setError(explain(err)); setOnline(false); }
    finally { setLoading(false); }
  }
  function updateSession(session: AppSession) {
    setCatalog(previous => previous ? { ...previous, sessions: previous.sessions.some(item => item.id === session.id) ? previous.sessions.map(item => item.id === session.id && item.revision <= session.revision ? { ...session, control: item.control } : item) : [...previous.sessions, session] } : previous);
  }
  async function chooseDirectory() {
    if (!bridge || bridge.kind === 'browser') return;
    setBusy(true); setFormError('');
    try {
      const picked = await bridge.selectProject();
      if (picked) {
        setCatalog(previous => previous ? { ...previous, projects: previous.projects.some(project => project.id === picked.id) ? previous.projects.map(project => project.id === picked.id ? picked : project) : [...previous.projects, picked] } : previous);
        setProjectId(picked.id);
      }
    } catch (err) { setFormError(explain(err)); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !projectId || !online || busy || !catalog?.engines.some(item => item.engine === engine && item.available)) return;
    if (titleError(title)) { setFormError(titleError(title)); return; }
    setBusy(true); setFormError('');
    try {
      const session = await bridge.invoke('session.create', { projectId, engine, title: title.trim() || defaultSessionTitle(engine), commandId: crypto.randomUUID() });
      updateSession(session); setSelected(session.id); setSearch('');
      setCollapsed(previous => { const next = new Set(previous); next.delete(projectId); return next; });
      createDialog.current?.close();
    } catch (err) { setFormError(explain(err)); }
    finally { setBusy(false); }
  }
  async function saveRename(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !current || !rename.trim() || busy) return;
    if (titleError(rename)) { setFormError(titleError(rename)); return; }
    setBusy(true); setFormError('');
    try {
      updateSession(await bridge.invoke('session.rename', { sessionId: current.id, title: rename.trim(), expectedRevision: current.revision }));
      renameDialog.current?.close();
    } catch (err) { setFormError(explain(err)); }
    finally { setBusy(false); }
  }
  async function acquireControl() {
    if (!bridge || !current || !online || controlBusy) return;
    const sessionId = current.id;
    setControlBusy(sessionId); setError('');
    try {
      // The authoritative catalog event carries the new lease; never silently acquire on view changes.
      await bridge.invoke('control.acquire', { sessionId });
    } catch (err) { setError(explain(err)); }
    finally { setControlBusy(value => value === sessionId ? null : value); }
  }
  function toggleProject(id: string) { setCollapsed(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  const query = search.trim().toLocaleLowerCase();
  const visibleProjects = catalog?.projects.map(project => ({ project, sessions: catalog.sessions.filter(session => session.projectId === project.id && `${session.title} ${project.name} ${engineNames[session.engine]}`.toLocaleLowerCase().includes(query)) })).filter(item => !query || item.sessions.length || item.project.name.toLocaleLowerCase().includes(query)) ?? [];
  function navigation(mobile = false) {
    return <>
      <div className="brand"><span className="brand-mark"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 10 9 12M18 10 9 22M21 22h4" /></svg></span><div><b>XTerminal</b><small>你的本地开发空间</small></div>{mobile && <button className="icon-button close-nav" aria-label="关闭导航" onClick={() => mobileNav.current?.close()}><Icon name="close" /></button>}</div>
      <button className="new-session" disabled={!bridge || !online || loading} onClick={openCreate}><Icon name="plus" />新建会话<kbd>⌘ N</kbd></button>
      <label className="search-box"><Icon name="search" /><input ref={mobile ? undefined : searchField} aria-label="搜索项目或会话" placeholder="搜索项目或会话" type="search" value={search} onChange={event => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label>
      <div className="nav-label"><span>项目</span><span>{catalog?.projects.length ?? 0} 个</span></div>
      <nav className="session-list" aria-label="项目与会话列表">
        {visibleProjects.map(({ project, sessions }) => <div className="project-group" key={project.id}>
          <button className="project-button" aria-expanded={!collapsed.has(project.id) || !!query} onClick={() => toggleProject(project.id)}><Icon name="chevron" className={!collapsed.has(project.id) || query ? 'expanded' : ''} /><Icon name="folder" /><span title={project.rootPath}>{project.name}</span><small>{sessions.length}</small></button>
          {(!collapsed.has(project.id) || query) && <div className="project-sessions">{sessions.map(session => <button key={session.id} className={`session-button ${selected === session.id ? 'active' : ''}`} aria-current={selected === session.id ? 'page' : undefined} onClick={() => { setSelected(session.id); mobileNav.current?.close(); }} title={session.title}><Icon name={engineIcons[session.engine]} /><span>{session.title}</span>{session.state === 'running' && <i className="dot" aria-label="运行中" />}{session.state === 'waiting' && <small className="nav-await">待确认</small>}</button>)}{!sessions.length && <p className="nav-empty">还没有会话</p>}</div>}
        </div>)}
        {!visibleProjects.length && <p className="nav-empty">{query ? '没有找到结果，可搜索项目、会话或引擎名称。' : '选择一个本地目录，开始工作。'}</p>}
      </nav>
      <div className="sidebar-bottom"><button className="phone-entry" onClick={() => { mobileNav.current?.close(); setShowLan(true); mobileInfo.current?.showModal(); }}><Icon name="phone" /><span><b>{bridge?.kind === 'browser' ? '连接状态' : '连接手机'}</b><small>{bridge?.kind === 'browser' ? '已通过加密连接访问电脑' : '同一内网，接着工作'}</small></span><Icon name="arrow" /></button><div className="profile"><span className="avatar">L</span><span><b>本地工作空间</b><small><i className={`dot ${online ? '' : 'quiet'}`} />{bridge ? online ? bridge.kind === 'browser' ? '已连接电脑' : '此电脑已连接' : '连接已断开' : '桌面应用专用'}</small></span><button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'} title={theme === 'light' ? '切换深色主题' : '切换浅色主题'}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button></div><div className="version-note"><span>本地开发工作空间</span><span>v0.1.1</span></div></div>
    </>;
  }
  const pickedProject = catalog?.projects.find(project => project.id === projectId);
  return <div className={`app ${navCollapsed ? 'nav-collapsed' : ''}`}>
    <aside className="sidebar">{navigation()}</aside>
    <main>
      <header className="main-header"><div className="header-context"><button className="icon-button" aria-label="展开或收起导航" aria-expanded={!navCollapsed} onClick={() => window.matchMedia('(max-width: 760px)').matches ? mobileNav.current?.showModal() : setNavCollapsed(value => !value)}><Icon name="panel" /></button><span className="project-crumb"><Icon name="folder" />{project?.name ?? '工作空间'}<span>/</span></span><strong title={current?.title}>{current?.title ?? '开始新的工作'}</strong></div><div className="header-status">{current && <><span className="engine-badge" title="创建后引擎固定"><Icon name={engineIcons[current.engine]} />{engineNames[current.engine]}</span><span className="status"><i className={`dot ${current.state === 'running' ? '' : 'quiet'}`} />{sessionStateName(current)}</span><button className="icon-button" aria-label="会话详情" onClick={() => detailDialog.current?.showModal()}><Icon name="info" /></button></>}</div></header>
      {!online && bridge && <div className="offline" role="alert"><Icon name="info" /><span><b>与此电脑的连接已断开</b><small>输入暂不可用；重新连接后可查看运行状态。</small></span><button className="secondary" disabled={loading} onClick={() => { void refresh(); }}>{loading ? '连接中…' : '重新连接'}</button></div>}
      {current && !canControl && <div className="readonly-banner" role="status"><Icon name="info" /><span><b>只读查看</b><small>{current.control ? '另一端正在操作，会话内容仍会实时更新。' : '尚无控制端，接管后可继续操作。'}</small></span><button className="secondary" disabled={!online || !!controlBusy} onClick={() => { void acquireControl(); }}>{controlBusy === current.id ? '正在接管…' : '接管操作'}</button></div>}
      {error && online && <div className="notice" role="alert">{error}<button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" /></button></div>}
      {loading && !catalog ? <div className="empty-state"><span className="empty-art"><Icon name="terminal" /></span><h1>正在打开工作空间</h1><p>正在读取此电脑上的项目与会话…</p></div> : !bridge ? <div className="empty-state"><span className="empty-art"><Icon name="terminal" /></span><span className="eyebrow">XTERMINAL · 本地开发空间</span><h1>请从桌面应用打开</h1><p>开发任务与 Shell 在你的电脑上运行。请启动 XTerminal 桌面应用，选择项目目录后开始工作。</p><small>手机请使用电脑开启内网连接后显示的 HTTPS 地址。</small></div> : current ? current.engine === 'shell' ? <Suspense fallback={<div className="empty-state"><p>正在打开终端…</p></div>}><TerminalPane key={current.id} bridge={bridge} session={current} online={online} canControl={canControl} onChange={updateSession} /></Suspense> : <Suspense fallback={<div className="empty-state"><p>正在打开会话…</p></div>}><AgentPane key={current.id} bridge={bridge} session={current} online={online} canControl={canControl} onChange={updateSession} /></Suspense> : <div className="empty-state"><span className="empty-art"><Icon name="terminal" /></span><span className="eyebrow">给专注的工作，留一块空间</span><h1>{!online ? '暂时无法打开工作空间' : '从一个项目开始'}</h1><p>{!online ? error || '请重新连接此电脑后继续。' : '选择本地目录，创建开发或 Shell 会话。你的任务、进程与工作进度都留在这里。'}</p><button className="primary" disabled={!online} onClick={openCreate}><Icon name="plus" />新建会话</button><div className="empty-footnote"><Icon name="folder" />本地目录<span>·</span>真实终端<span>·</span>会话持续保留</div></div>}
    </main>
    <dialog className="nav-dialog" ref={mobileNav} aria-label="项目与会话导航" onClick={event => { if (event.target === event.currentTarget) mobileNav.current?.close(); }}><div className="sidebar mobile-sidebar">{navigation(true)}</div></dialog>
    <dialog className="create-dialog" ref={createDialog} aria-labelledby="create-title"><form onSubmit={create}>
      <div className="modal-top"><span className="modal-icon"><Icon name="plus" /></span><button className="icon-button" aria-label="关闭新建会话" type="button" onClick={() => createDialog.current?.close()}><Icon name="close" /></button></div>
      <h1 id="create-title">开始一段新的工作</h1><p className="muted">选好项目和引擎，在会话里继续。</p>
      <div className="form-section"><label htmlFor="project-select">工作项目</label><div className="project-picker"><select id="project-select" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={busy}>{!catalog?.projects.length && <option value="">{bridge?.kind === 'browser' ? '请先在电脑上添加项目' : '先选择本地目录'}</option>}{catalog?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>{bridge?.kind !== 'browser' && <button className="secondary" type="button" onClick={() => { void chooseDirectory(); }} disabled={busy || !online}><Icon name="folder" />选择目录</button>}</div><span className="field-label">工作目录</span><div className="directory-path">{pickedProject?.rootPath ?? (bridge?.kind === 'browser' ? '从电脑上已有的项目中选择工作目录' : '通过系统窗口选择一个本地目录')}</div></div>
      <fieldset className="engine-fieldset"><legend>选择引擎</legend>{(['claude', 'codex', 'shell'] as EngineKind[]).map(kind => { const availability = catalog?.engines.find(item => item.engine === kind); const available = !!availability?.available; return <button key={kind} type="button" className={`engine-option ${engine === kind ? 'selected' : ''}`} disabled={!available || busy} aria-pressed={engine === kind} onClick={() => setEngine(kind)}><span className={`engine-symbol ${kind}`}><Icon name={engineIcons[kind]} /></span><span><b>{engineNames[kind]}{!available && <em>暂不可用</em>}</b><small>{!available ? availability?.reason ?? '此引擎尚未接入' : kind === 'shell' ? '运行命令、脚本与开发服务' : kind === 'claude' ? '与 Claude Code 讨论并推进开发任务' : '交给 Codex 理解代码与完成任务'}</small></span><i className="radio" /></button>; })}</fieldset>
      <p className="locked"><Icon name="info" />创建后引擎固定，可分别创建不同引擎的会话。</p><label htmlFor="session-title">会话名称 <span className="optional">选填</span></label><input id="session-title" value={title} onChange={event => setTitle(event.target.value)} placeholder={defaultSessionTitle(engine)} maxLength={MAX_TITLE_LENGTH} disabled={busy} />
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="modal-actions"><button className="secondary" type="button" onClick={() => createDialog.current?.close()}>取消</button><button className="primary" disabled={busy || !online || !projectId || !catalog?.engines.some(item => item.engine === engine && item.available)}>{busy ? '正在处理…' : '创建会话'}<Icon name="arrow" /></button></div>
    </form></dialog>
    <dialog ref={detailDialog} className="detail-dialog" aria-labelledby="detail-title"><div className="modal-top"><h2 id="detail-title">会话详情</h2><button className="icon-button" aria-label="关闭会话详情" onClick={() => detailDialog.current?.close()}><Icon name="close" /></button></div>{current && <><dl><dt>会话名称</dt><dd>{current.title}</dd><dt>项目</dt><dd>{project?.name}</dd><dt>初始工作目录</dt><dd><code>{current.initialCwd}</code></dd><dt>会话引擎</dt><dd>{engineNames[current.engine]}<small>创建后固定，不能切换</small></dd><dt>当前状态</dt><dd>{sessionStateName(current)}</dd><dt>运行位置</dt><dd>{bridge?.kind === 'browser' ? '电脑端 · 本地项目' : '此电脑 · 本地'}</dd></dl><button className="secondary" disabled={!online} onClick={() => { setRename(current.title); setFormError(''); detailDialog.current?.close(); renameDialog.current?.showModal(); }}><Icon name="edit" />重命名会话</button><p className="muted">{current.engine === 'shell' ? '切换会话或关闭窗口后，已启动的 Shell 继续运行。结束 Shell 可停止该会话的进程。' : '切换会话或关闭窗口不会结束正在进行的任务。使用“停止任务”中断当前轮次。'}</p></>}</dialog>
    <dialog ref={renameDialog} aria-labelledby="rename-title"><form onSubmit={saveRename}><div className="modal-top"><h2 id="rename-title">重命名会话</h2><button className="icon-button" type="button" aria-label="关闭重命名" onClick={() => renameDialog.current?.close()}><Icon name="close" /></button></div><label htmlFor="rename-input">会话名称</label><input id="rename-input" value={rename} onChange={event => setRename(event.target.value)} maxLength={MAX_TITLE_LENGTH} autoFocus required />{formError && <p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => renameDialog.current?.close()}>取消</button><button className="primary" disabled={busy || !rename.trim() || !online}>{busy ? '保存中…' : '保存名称'}</button></div></form></dialog>
    <dialog ref={mobileInfo} className="lan-dialog" aria-labelledby="mobile-info-title"><div className="modal-top"><h2 id="mobile-info-title">{bridge?.kind === 'browser' ? '连接状态' : '连接手机'}</h2><button className="icon-button" aria-label="关闭连接设置" onClick={() => mobileInfo.current?.close()}><Icon name="close" /></button></div>{bridge?.kind === 'browser' ? <><p className="muted">{online ? '已通过 HTTPS 加密连接到电脑。设备授权与连接设置由电脑端管理。' : '与电脑的连接已断开，正在等待重新连接。'}</p><p className="muted">关闭本页即可离开；电脑上的任务会继续运行。结束共享或撤销此设备，请在电脑端操作。</p></> : bridge && showLan ? <Suspense fallback={<p className="muted">正在打开连接设置…</p>}><LanPanel bridge={bridge} /></Suspense> : <p className="muted">请先从桌面应用打开，再管理手机连接。</p>}</dialog>
  </div>;
}
