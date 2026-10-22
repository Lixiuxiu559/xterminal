const $ = selector => document.querySelector(selector);
const engines = {
  claude: { name: 'Claude Code', symbol: icon('spark'), color: 'claude', greeting: '把想法变成下一步。' },
  codex: { name: 'Codex', symbol: icon('code'), color: 'codex', greeting: '从这里，开始推进。' },
  shell: { name: 'Shell', symbol: icon('terminal'), color: 'shell' },
};
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const sessions = [
  { id: 1, project: 'xterminal', title: '梳理项目与开发计划', engine: 'claude', dir: '~/Projects/xterminal', state: '就绪', demo: true, messages: [] },
  { id: 2, project: 'xterminal', title: '实现手机连接流程', engine: 'codex', dir: '~/Projects/xterminal', state: '就绪', messages: [
    { type: 'user', text: '我们先梳理一下，手机连接电脑需要几个步骤？' },
    { type: 'agent', text: '可以分成三步：打开电脑提供的内网地址、完成设备配对、进入已有会话。\n\n连接成功后，手机与电脑共享同一个会话。断线时保留草稿，重新连接后再继续发送。' },
  ] },
  { id: 3, project: 'xterminal', title: '本地开发服务', engine: 'shell', dir: '~/Projects/xterminal', state: '进程运行', running: true, output: [
    { text: 'Last login: Thu Oct 22 09:41:08 on ttys002', dim: true },
    { text: '❯ pnpm dev', green: true },
    { text: '\n  VITE  ready in 182 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  press h + enter to show help\n\n09:42:16 [vite] page reload src/App.tsx' },
  ] },
  { id: 5, project: 'xterminal', title: '检查项目依赖', engine: 'claude', dir: '~/Projects/xterminal', state: '等待授权', requiresApproval: true, messages: [
    { type: 'user', text: '帮我检查一下项目依赖和目录结构。' },
    { type: 'agent', text: '我会先查看项目文件结构，再检查依赖配置。运行下面的命令需要你的确认。' },
  ] },
  { id: 4, project: 'personal-site', title: '设计首页内容', engine: 'codex', dir: '~/Projects/personal-site', state: '就绪', messages: [] },
];
let active = 1;
let selectedEngine = 'claude';
let online = true;
let paired = false;
let searchTerm = '';
let toastTimer;
let previousNavFocus;
const collapsedProjects = new Set();
const current = () => sessions.find(session => session.id === active);
const isMobileLayout = () => $('.app').getBoundingClientRect().width <= 760;

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000);
}
function renderNav() {
  const projects = [...new Set(sessions.map(session => session.project))];
  $('#project-count').textContent = `${projects.length} 个`;
  const matches = session => !searchTerm || [session.title, session.project, engines[session.engine].name].some(value => value.toLowerCase().includes(searchTerm));
  $('#session-list').innerHTML = projects.map(project => {
    const items = sessions.filter(session => session.project === project && matches(session));
    if (!items.length) return '';
    const collapsed = collapsedProjects.has(project) && !searchTerm;
    return `<div class="project-group"><button class="project-label" data-project="${escapeHTML(project)}" aria-expanded="${!collapsed}"><span class="chevron ${collapsed ? 'is-collapsed' : ''}">${icon('chevron')}</span><span class="project-folder">${icon(collapsed ? 'folder' : 'folder-open')}</span><span>${escapeHTML(project)}</span><span class="project-count">${items.length}</span></button><div class="project-sessions" ${collapsed ? 'hidden' : ''}>${items.map(session => {
      const engine = engines[session.engine];
      const status = session.state === '等待授权' ? '<span class="item-status wait">待确认</span>' : ['执行中', '正在停止'].includes(session.state) ? '<span class="item-status"><i class="dot pulse"></i><span class="sr-only">执行中</span></span>' : session.engine === 'shell' && session.running ? '<span class="item-status"><i class="dot"></i><span class="sr-only">服务运行中</span></span>' : '';
      return `<button class="session-item ${session.id === active ? 'active' : ''}" data-session="${session.id}" ${session.id === active ? 'aria-current="page"' : ''} title="${escapeHTML(session.title)} · ${engine.name}"><span class="mini-symbol ${engine.color}">${engine.symbol}</span><span class="item-name">${escapeHTML(session.title)}</span>${status}</button>`;
    }).join('')}</div></div>`;
  }).join('') || `<div class="search-empty">${icon('search')}<b>没有找到相关会话</b><p>试试项目名、会话名或引擎名称。</p></div>`;
  document.querySelectorAll('[data-session]').forEach(button => button.onclick = () => {
    active = Number(button.dataset.session);
    closeNav(false);
    render();
  });
  document.querySelectorAll('[data-project]').forEach(button => button.onclick = () => {
    const project = button.dataset.project;
    collapsedProjects.has(project) ? collapsedProjects.delete(project) : collapsedProjects.add(project);
    renderNav();
    [...document.querySelectorAll('[data-project]')].find(node => node.dataset.project === project)?.focus();
  });
}
function agentMessage(content, session, extra = '') {
  return `<article class="message agent-message ${extra}"><div class="agent-heading"><span class="agent-avatar ${session.engine}">${engines[session.engine].symbol}</span><b>${engines[session.engine].name}</b><span class="message-time">09:42</span></div><div class="agent-body">${content}</div></article>`;
}
function renderMessages(session) {
  let html = '';
  if (session.demo) {
    html = `<div class="day-divider"><span>今天</span></div><article class="message user-message"><div class="user-bubble">帮我梳理一下这个项目，列出接下来应该优先处理的开发任务。</div><span class="user-avatar">L</span></article>`;
    html += agentMessage(`<p>已经整理好了。建议围绕一条完整流程推进：<strong>电脑开始工作，手机接着操作。</strong></p><details class="tool-card"><summary><span class="tool-check">${icon('check')}</span><span>已阅读项目需求与目录</span><span class="tool-count">2 项</span>${icon('chevron', 'tool-chevron')}</summary><div class="tool-content"><code>docs/PRD.md</code><code>prototype/</code><p>已梳理三种会话引擎、内网接入方式与本地执行边界。</p></div></details><p>接下来可以优先处理这三件事：</p><ol class="task-outline"><li><span>01</span><div><strong>把会话管理做好</strong><p>按项目组织，清楚显示引擎、任务进展和需要你处理的事项。</p></div></li><li><span>02</span><div><strong>跑通一个完整的开发会话</strong><p>从发送需求到查看结果，先让电脑端的体验连贯可靠。</p></div></li><li><span>03</span><div><strong>让手机接入同一个会话</strong><p>覆盖查看进展、继续输入、权限确认和断线重连。</p></div></li></ol><p class="agent-closing">你想先从哪一项开始？</p><div class="message-meta">${icon('check')} 已完成整理 <span>·</span> <button data-fill="先细化会话管理的页面和交互">先细化会话管理 ${icon('arrow-right')}</button></div>`, session);
  }
  html += session.messages.map(message => message.type === 'user'
    ? `<article class="message user-message"><div class="user-bubble">${escapeHTML(message.text)}</div><span class="user-avatar">L</span></article>`
    : agentMessage(`<p>${escapeHTML(message.text).replace(/\n/g, '<br>')}</p>`, session)).join('');
  if (!html) {
    html = `<div class="welcome"><div class="welcome-art"><span class="welcome-orbit orbit-one"></span><span class="welcome-orbit orbit-two"></span><span class="welcome-symbol ${session.engine}">${engines[session.engine].symbol}</span></div><span class="welcome-eyebrow">${escapeHTML(session.project)} / 新会话</span><h2>${engines[session.engine].greeting}</h2><p>${engines[session.engine].name} 已准备好。描述你的任务，从一个清楚的目标开始。</p><div class="welcome-chips"><button data-fill="帮我了解这个项目的结构">${icon('folder')}了解项目</button><button data-fill="帮我拆解接下来的开发任务">${icon('list')}拆解任务</button><button data-fill="帮我梳理当前代码的改进方向">${icon('code')}梳理代码</button></div></div>`;
  }
  if (['执行中', '正在停止'].includes(session.state)) {
    html += agentMessage(`<div class="thinking"><span class="thinking-dots"><i></i><i></i><i></i></span><span>${session.state === '正在停止' ? '正在停止当前任务…' : '正在处理你的任务…'}</span></div>`, session, 'running-message');
  }
  $('#conversation').innerHTML = html;
  document.querySelectorAll('[data-fill]').forEach(button => button.onclick = () => {
    session.draft = button.dataset.fill;
    $('#message-input').value = session.draft;
    updateInput();
    $('#message-input').focus();
  });
  $('#conversation').scrollTop = session.messages.length ? $('#conversation').scrollHeight : 0;
}
function renderTerminal(session) {
  $('#terminal-output').innerHTML = session.output.map(line => `<div class="${line.green ? 'green' : line.dim ? 'dim' : ''}">${escapeHTML(line.text)}</div>`).join('');
  $('#shell-input').value = session.shellDraft || '';
  $('#shell-input').disabled = !online;
  $('.terminal-submit').disabled = !online;
  $('#ctrl-c').disabled = !online;
  $('#shell-process').textContent = session.running ? '开发服务运行中' : 'Shell 已就绪';
  $('#terminal-scroll').scrollTop = $('#terminal-scroll').scrollHeight;
}
function renderPending(session) {
  const pending = session.requiresApproval && !session.permissionDone;
  $('#pending-action').hidden = !pending;
  $('#chat-form').hidden = pending;
  $('#input-hint').hidden = pending;
  $('#pending-action').innerHTML = pending ? `<div class="permission"><div class="permission-title"><span class="permission-icon">${icon('shield')}</span><div><b>需要你确认一次操作</b><p>${engines[session.engine].name} 希望查看项目文件结构。</p></div><span class="permission-tag">执行命令</span></div><code><span>$</span> find src -maxdepth 2 -type f</code><div class="permission-actions"><span>${icon('monitor')} 此电脑</span><button class="secondary" id="deny" ${!online ? 'disabled' : ''}>拒绝</button><button class="primary" id="allow" ${!online ? 'disabled' : ''}>允许本次${icon('check')}</button></div></div>` : '';
  $('#allow')?.addEventListener('click', () => permission('allow'));
  $('#deny')?.addEventListener('click', () => permission('deny'));
}
function updateInput() {
  const session = current();
  const busy = ['执行中', '正在停止'].includes(session.state);
  $('#message-input').style.height = 'auto';
  $('#message-input').style.height = `${Math.min(Math.max($('#message-input').scrollHeight, 54), 180)}px`;
  $('#send').disabled = !online || busy || session.state === '等待授权' || !$('#message-input').value.trim();
}
function render() {
  const session = current();
  const engine = engines[session.engine];
  renderNav();
  $('#project-name').textContent = session.project;
  $('#session-name').textContent = session.title;
  $('#engine-badge').innerHTML = `<span class="${engine.color}">${engine.symbol}</span><span class="engine-name">${engine.name}</span>`;
  $('#engine-badge').setAttribute('aria-label', `${engine.name}，此会话引擎固定`);
  $('#status').innerHTML = `${session.state === '等待授权' ? icon('info') : '<i class="dot"></i>'}<span>${session.engine === 'shell' ? session.running ? '服务运行中' : '就绪' : session.state === '等待授权' ? '待确认' : session.state}</span>`;
  $('#status').classList.toggle('needs-attention', session.state === '等待授权');
  $('#working-dir').textContent = session.dir;
  $('#detail-project').textContent = session.project;
  $('#detail-engine').innerHTML = `<span class="${engine.color}">${engine.symbol}</span>${engine.name}`;
  $('#detail-state').textContent = session.state;
  $('#detail-dot').classList.toggle('disconnected', !online);
  $('#conversation').hidden = session.engine === 'shell';
  $('#composer-area').hidden = session.engine === 'shell';
  $('#terminal-view').hidden = session.engine !== 'shell';
  $('#composer-project').textContent = session.project;
  $('#message-input').value = session.draft || '';
  $('#message-input').disabled = !online;
  const busy = ['执行中', '正在停止'].includes(session.state);
  $('#send').hidden = busy;
  $('#stop').hidden = !busy;
  $('#stop').disabled = !online || session.state === '正在停止';
  renderPending(session);
  $('#offline').hidden = online;
  $('#connection-status').textContent = online ? '电脑已连接' : '连接已断开';
  $('#settings-connection').textContent = online ? '电脑已连接' : '连接已断开';
  $('#simulate-offline').textContent = online ? '模拟断线' : '重新连接';
  $('#input-hint').textContent = isMobileLayout() ? '点击箭头发送 · 回车换行' : 'Enter 发送 · Shift + Enter 换行';
  if (session.engine === 'shell') renderTerminal(session); else renderMessages(session);
  updateInput();
}
function permission(action) {
  const session = current();
  if (!online) return toast('连接断开，重新连接后可处理授权');
  session.permissionDone = action;
  session.state = '就绪';
  session.messages.push({ type: 'agent', text: action === 'allow' ? '本次操作已获准。这里将继续显示检查结果。\n\n当前是原型演示，没有实际执行命令。' : '已拒绝这次命令。我不会执行该操作，你可以继续补充需求。' });
  render();
}
$('#chat-form').onsubmit = event => {
  event.preventDefault();
  const session = current();
  const text = $('#message-input').value.trim();
  if (!online || !text || ['执行中', '正在停止', '等待授权'].includes(session.state)) return;
  session.messages.push({ type: 'user', text });
  session.draft = '';
  session.state = '执行中';
  render();
  session.timer = setTimeout(() => {
    session.messages.push({ type: 'agent', text: `收到，我们继续处理“${text}”。\n\n当前是 ${engines[session.engine].name} 的交互演示，接入真实引擎后会在这里持续显示执行进展与结果。` });
    session.state = '就绪';
    active === session.id ? render() : renderNav();
  }, 1800);
};
$('#message-input').oninput = event => { current().draft = event.target.value; updateInput(); };
$('#message-input').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isMobileLayout()) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
};
$('#stop').onclick = () => {
  if (!online) return;
  const session = current();
  clearTimeout(session.timer);
  session.state = '正在停止';
  render();
  setTimeout(() => {
    session.state = '就绪';
    session.messages.push({ type: 'agent', text: '当前任务已停止。你可以调整要求，或继续发送新的消息。（演示）' });
    active === session.id ? render() : renderNav();
  }, 600);
};
$('#shell-input').oninput = event => { current().shellDraft = event.target.value; };
$('#shell-form').onsubmit = event => {
  event.preventDefault();
  if (!online) return;
  const session = current();
  const command = $('#shell-input').value.trim();
  if (!command) return;
  session.shellDraft = '';
  session.output.push({ text: `❯ ${command}`, green: true });
  if (command === 'pwd') session.output.push({ text: session.dir.replace('~', '/Users/lixiuxiu') });
  else if (command.startsWith('cd ')) {
    const target = command.slice(3).trim();
    if (target.startsWith('/') || target.startsWith('~')) session.dir = target;
    else if (target === '..') session.dir = session.dir.split('/').slice(0, -1).join('/') || '/';
    else session.dir = `${session.dir.replace(/\/$/, '')}/${target}`;
    session.output.push({ text: `当前目录：${session.dir}`, dim: true });
  } else if (command === 'ls') session.output.push({ text: 'docs/       prototype/       README.md' });
  else if (command === 'clear') session.output = [];
  else if (command === 'pnpm dev') {
    session.running = true;
    session.output.push({ text: 'VITE  ready in 182 ms\n➜  Local: http://localhost:5173/\n开发服务正在运行（模拟）' });
  } else if (command.startsWith('echo ')) session.output.push({ text: command.slice(5) });
  else session.output.push({ text: `原型已接收命令，未实际执行：${command}`, dim: true });
  render();
  $('#shell-input').focus();
};
function interruptShell() {
  if (!online) return;
  const session = current();
  session.running = false;
  session.output.push({ text: '^C', green: true }, { text: '已中断当前命令（演示），Shell 仍在运行。', dim: true });
  render();
}
$('#ctrl-c').onclick = interruptShell;
$('#shell-input').onkeydown = event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'c') { event.preventDefault(); interruptShell(); }
};
$('#clear-terminal').onclick = () => { current().output = []; render(); };
function openCreate() { closeNav(false); $('#create-dialog').showModal(); }
$('#new-session').onclick = openCreate;
document.querySelectorAll('[data-engine]').forEach(button => button.onclick = () => {
  selectedEngine = button.dataset.engine;
  document.querySelectorAll('[data-engine]').forEach(node => { node.classList.toggle('selected', node === button); node.setAttribute('aria-pressed', String(node === button)); });
});
$('#project-select').onchange = event => { $('#directory').value = `~/Projects/${event.target.value}`; };
$('#directory').oninput = () => $('#directory').setCustomValidity('');
$('#create-form').onsubmit = event => {
  event.preventDefault();
  const directory = $('#directory').value.trim();
  if (!directory) { $('#directory').setCustomValidity('请输入工作目录'); $('#directory').reportValidity(); return; }
  const id = Date.now();
  const engine = selectedEngine;
  sessions.push({ id, project: $('#project-select').value, title: $('#new-title').value.trim() || (engine === 'shell' ? '新的 Shell 会话' : '新的开发会话'), engine, dir: directory, state: engine === 'shell' ? '进程运行' : '就绪', messages: [], output: engine === 'shell' ? [{ text: 'Shell 会话已就绪 · 交互原型\n可试用 pwd、ls、cd、echo、pnpm dev。', dim: true }] : [] });
  active = id;
  collapsedProjects.delete($('#project-select').value);
  searchTerm = '';
  $('#session-search').value = '';
  $('#create-dialog').close();
  $('#new-title').value = '';
  render();
  toast(`已创建 ${engines[engine].name} 会话`);
};
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('#connection').onclick = () => { closeNav(false); $('#connect-dialog').showModal(); };
$('#copy-address').onclick = async () => {
  try { await navigator.clipboard.writeText('http://192.168.1.8:7680'); toast('已复制示例地址，暂不能用于真实连接'); }
  catch { toast('示例地址：http://192.168.1.8:7680'); }
};
$('#pair-phone').onclick = () => {
  paired = !paired;
  $('#phone-state').textContent = paired ? '已授权 · 当前在线（演示）' : '访问已撤销';
  $('#phone-state').classList.toggle('is-paired', paired);
  $('#pair-phone').textContent = paired ? '撤销访问' : '模拟配对';
  toast(paired ? '设备已授权（演示）' : '已撤销设备访问（演示）');
};
function mobilePreview() {
  closeNav(false);
  toggleDetails(false);
  document.body.classList.add('mobile-preview');
  if (!$('.mobile-return')) {
    const button = document.createElement('button');
    button.className = 'mobile-return';
    button.innerHTML = `${icon('monitor')}返回桌面布局`;
    button.onclick = () => { closeNav(false); toggleDetails(false); document.body.classList.remove('mobile-preview'); button.remove(); history.replaceState(null, '', location.pathname); resizeViewport(); };
    document.body.append(button);
  }
  resizeViewport();
}
$('#mobile-preview').onclick = () => { $('#connect-dialog').close(); mobilePreview(); };
function closeNav(restoreFocus = true) {
  const wasOpen = $('.app').classList.contains('nav-open');
  $('.app').classList.remove('nav-open');
  $('#nav-backdrop').hidden = true;
  $('#main').inert = false;
  $('#open-nav').setAttribute('aria-expanded', String(!isMobileLayout() && !$('.app').classList.contains('nav-collapsed')));
  if (wasOpen && restoreFocus) previousNavFocus?.focus();
}
function openNav() {
  if (!isMobileLayout()) {
    $('.app').classList.toggle('nav-collapsed');
    $('#open-nav').setAttribute('aria-expanded', String(!$('.app').classList.contains('nav-collapsed')));
    return;
  }
  if ($('.app').classList.contains('nav-open')) return closeNav();
  previousNavFocus = document.activeElement;
  $('.app').classList.add('nav-open');
  $('#nav-backdrop').hidden = false;
  $('#main').inert = true;
  $('#open-nav').setAttribute('aria-expanded', 'true');
  $('#close-nav').focus();
}
$('#open-nav').onclick = openNav;
$('#close-nav').onclick = () => closeNav();
$('#nav-backdrop').onclick = () => closeNav();
$('#about').onclick = () => { closeNav(false); $('#settings-dialog').showModal(); };
$('#settings-mobile').onclick = () => { $('#settings-dialog').close(); mobilePreview(); };
$('#session-search').oninput = event => { searchTerm = event.target.value.trim().toLowerCase(); renderNav(); };
function toggleDetails(force) {
  const show = force ?? $('#details-panel').hidden;
  $('#details-panel').hidden = !show;
  $('#details-toggle').setAttribute('aria-expanded', String(show));
  $('.work-content').inert = show && isMobileLayout();
  if (show && isMobileLayout()) {
    $('#details-panel').setAttribute('role', 'dialog');
    $('#details-panel').setAttribute('aria-modal', 'true');
    $('#close-details').focus();
  } else {
    $('#details-panel').removeAttribute('role');
    $('#details-panel').removeAttribute('aria-modal');
    if (!show) $('#details-toggle').focus();
  }
}
$('#details-toggle').onclick = () => toggleDetails();
$('#close-details').onclick = () => toggleDetails(false);
$('#detail-connect').onclick = () => $('#connect-dialog').showModal();
$('#rename').onclick = () => { $('#rename-input').value = current().title; $('#rename-dialog').showModal(); };
$('#rename-form').onsubmit = event => {
  event.preventDefault();
  const title = $('#rename-input').value.trim();
  if (!title) return;
  current().title = title;
  $('#rename-dialog').close();
  render();
  toast('会话名称已更新');
};
function toggleConnection() {
  online = !online;
  $('#settings-dialog').close();
  closeNav(false);
  render();
  toast(online ? '已恢复连接（演示）' : '已模拟断线，草稿已保留');
}
$('#simulate-offline').onclick = toggleConnection;
$('#reconnect').onclick = toggleConnection;
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-light').setAttribute('aria-pressed', String(theme === 'light'));
  $('#theme-dark').setAttribute('aria-pressed', String(theme === 'dark'));
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f7f8f5' : '#19211d';
  try { localStorage.setItem('xterminal-theme', theme); } catch { /* 文件预览不一定允许存储。 */ }
}
$('#theme-light').onclick = () => setTheme('light');
$('#theme-dark').onclick = () => setTheme('dark');
function resizeViewport() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height || innerHeight}px`);
  $('#input-hint').textContent = isMobileLayout() ? '点击箭头发送 · 回车换行' : 'Enter 发送 · Shift + Enter 换行';
  $('.work-content').inert = !$('#details-panel').hidden && isMobileLayout();
  if (!$('#details-panel').hidden) {
    if (isMobileLayout()) { $('#details-panel').setAttribute('role', 'dialog'); $('#details-panel').setAttribute('aria-modal', 'true'); }
    else { $('#details-panel').removeAttribute('role'); $('#details-panel').removeAttribute('aria-modal'); }
  }
  if (!isMobileLayout() && $('.app').classList.contains('nav-open')) closeNav(false);
}
window.visualViewport?.addEventListener('resize', resizeViewport);
window.addEventListener('resize', resizeViewport);
document.addEventListener('keydown', event => {
  const modalOpen = !!document.querySelector('dialog[open]');
  if ((event.metaKey || event.ctrlKey) && event.key === 'k' && !modalOpen) {
    event.preventDefault();
    $('.app').classList.remove('nav-collapsed');
    if (isMobileLayout() && !$('.app').classList.contains('nav-open')) openNav();
    $('#session-search').focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'n' && !modalOpen) { event.preventDefault(); openCreate(); }
  if (event.key === 'Escape' && !modalOpen) {
    if ($('.app').classList.contains('nav-open')) closeNav();
    else if (!$('#details-panel').hidden) toggleDetails(false);
  }
  if (event.key === 'Tab' && !modalOpen) {
    const layer = $('.app').classList.contains('nav-open') ? $('#sidebar') : isMobileLayout() && !$('#details-panel').hidden ? $('#details-panel') : null;
    if (!layer) return;
    const nodes = [...layer.querySelectorAll('button:not(:disabled), input:not(:disabled), select, [tabindex="0"]')].filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
try { setTheme(localStorage.getItem('xterminal-theme') === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }
render();
if (new URLSearchParams(location.search).get('mobile') === '1') mobilePreview();
resizeViewport();
