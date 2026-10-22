import { randomId } from './randomId.ts';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AppSession, DesktopBridge } from '../../../packages/protocol/src/desktop';
import type { AgentAnswer, AgentInteraction, AgentMessage, AgentQuestion, AgentSnapshot, AgentModel } from '../../../packages/protocol/src/agent';
import { Icon } from './icons';
import { sessionStateName } from './sessionState';
import { agentSendError, agentTextError, MAX_AGENT_TEXT_BYTES, ownValue, modelTurnParameters, restoreModelSelection } from './uiValidation';

// Keep unfinished input only in this renderer's memory; switching sessions does not persist it to disk.
const drafts = new Map<string, string>();
const modelChoices = new Map<string, string>();
const answerDrafts = new Map<string, Record<string, string[]>>();
const customAnswerDrafts = new Map<string, Record<string, string>>();
const engineNames = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell' };
const actionNames: Record<AgentAnswer['action'], string> = { 'allow-once': '允许本次', deny: '拒绝操作', 'cancel-turn': '取消本轮', submit: '提交回答' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试。';

function uniqueById<T extends { id: string }>(items: T[]) { return [...new Map(items.map(item => [item.id, item])).values()]; }
function normalize(snapshot: AgentSnapshot): AgentSnapshot {
  const messages = new Map<string, AgentMessage>();
  for (const message of snapshot.messages) {
    const previous = messages.get(message.id);
    // If a provider includes both delta and final records, the final content wins for the same ID.
    if (!previous || previous.status === 'streaming' || message.status !== 'streaming') messages.set(message.id, message);
  }
  return { ...snapshot, messages: [...messages.values()], tools: uniqueById(snapshot.tools), interactions: uniqueById(snapshot.interactions) };
}

export function AgentPane({ bridge, session, online, canControl, onChange }: { bridge: DesktopBridge; session: AppSession; online: boolean; canControl: boolean; onChange: (session: AppSession) => void }) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [draft, setDraft] = useState(() => drafts.get(session.id) ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => modelChoices.get(session.id) ?? '');
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const userPickedModel = useRef(modelChoices.has(session.id));
  const modelRequest = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const followBottom = useRef(true);
  const eventVersion = useRef(0);
  const alive = useRef(false);
  const name = engineNames[session.engine];
  const busy = ['starting', 'running', 'waiting', 'stopping'].includes(session.state) || sending || stopping;
  const waiting = session.state === 'waiting' || !!snapshot?.interactions.length;
  const draftError = agentTextError(draft);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const unsubscribe = bridge.onEvent(event => {
      if (disposed || event.type !== 'agent.changed' || event.snapshot.sessionId !== session.id) return;
      eventVersion.current += 1;
      setSnapshot(normalize(event.snapshot)); setLoading(false);
    });
    // Listen first. A newer event received while restoring history must win over the request result.
    const version = eventVersion.current;
    bridge.invoke('agent.snapshot', { sessionId: session.id }).then(result => {
      if (!disposed && eventVersion.current === version) setSnapshot(normalize(result));
    }).catch(err => { if (!disposed) setError(errorText(err)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; alive.current = false; unsubscribe(); };
  }, [bridge, session.id]);
  useEffect(() => {
    if (session.engine !== 'codex') return;
    setSelectedModel(current => restoreModelSelection(current, snapshot?.model, userPickedModel.current));
  }, [snapshot?.model, session.engine]);
  async function loadModels() {
    if (session.engine !== 'codex' || !online) return;
    const request = ++modelRequest.current;
    setModelsLoading(true); setModelsError('');
    try {
      const result = await bridge.invoke('engine.models', { engine: 'codex' });
      if (alive.current && modelRequest.current === request) setModels(uniqueById(result.filter(model => model.id.length > 0)));
    } catch (err) { if (alive.current && modelRequest.current === request) setModelsError(errorText(err)); }
    finally { if (alive.current && modelRequest.current === request) setModelsLoading(false); }
  }
  useEffect(() => {
    if (session.engine === 'codex' && online) void loadModels();
    else setModelsLoading(false);
    return () => { modelRequest.current += 1; };
  }, [bridge, session.engine, session.id, online]);
  function changeModel(value: string) {
    userPickedModel.current = true; modelChoices.set(session.id, value); setSelectedModel(value);
  }
  const previousOnline = useRef(online);
  useEffect(() => {
    const reconnecting = !previousOnline.current && online;
    previousOnline.current = online;
    if (!reconnecting) return;
    let disposed = false;
    const version = eventVersion.current;
    bridge.invoke('agent.snapshot', { sessionId: session.id }).then(result => { if (!disposed && eventVersion.current === version) setSnapshot(normalize(result)); }).catch(err => { if (!disposed) setError(errorText(err)); });
    return () => { disposed = true; };
  }, [bridge, online, session.id]);
  useEffect(() => {
    if (!['starting', 'running', 'waiting', 'stopping'].includes(session.state)) setStopping(false);
  }, [session.state]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && followBottom.current) node.scrollTop = node.scrollHeight;
  }, [snapshot, session.state, loading]);
  useLayoutEffect(() => {
    const node = composer.current;
    if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(180, Math.max(64, node.scrollHeight))}px`; }
  }, [draft]);

  async function restore() {
    if (!online) return;
    setLoading(true); setError('');
    const version = eventVersion.current;
    try {
      const result = await bridge.invoke('agent.snapshot', { sessionId: session.id });
      if (alive.current && eventVersion.current === version) setSnapshot(normalize(result));
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { if (alive.current) setLoading(false); }
  }
  function changeDraft(text: string) { drafts.set(session.id, text); setDraft(text); }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (draftError) { setError(draftError); return; }
    if (!online || !canControl || busy || waiting || !text || !snapshot) return;
    setSending(true); setError(''); followBottom.current = true;
    try {
      const updated = await bridge.invoke('agent.turn.start', { sessionId: session.id, text, commandId: randomId(), ...modelTurnParameters(session.engine, selectedModel) });
      if (!alive.current) { if (drafts.get(session.id) === draft) drafts.delete(session.id); return; }
      changeDraft(''); onChange(updated);
    } catch (err) { if (alive.current) setError(agentSendError(err)); }
    finally { if (alive.current) setSending(false); }
  }
  async function stop() {
    if (!online || !canControl || !session.runId || stopping || session.state === 'stopping') return;
    setStopping(true); setError('');
    try {
      const updated = await bridge.invoke('agent.turn.stop', { sessionId: session.id, runId: session.runId });
      if (alive.current) { onChange(updated); if (!['starting', 'running', 'waiting', 'stopping'].includes(updated.state)) setStopping(false); }
    } catch (err) { if (alive.current) { setError(errorText(err)); setStopping(false); } }
  }
  async function respond(interaction: AgentInteraction, answer: AgentAnswer) {
    if (!online || !canControl || responding || session.runId !== interaction.runId || stopping || session.state === 'stopping') return;
    setResponding(interaction.id); setError('');
    const version = eventVersion.current;
    try {
      const result = await bridge.invoke('agent.respond', { sessionId: session.id, runId: interaction.runId, interactionId: interaction.id, answer });
      if (alive.current) {
        if (eventVersion.current === version) setSnapshot(normalize(result));
        answerDrafts.delete(`${session.id}:${interaction.id}`); customAnswerDrafts.delete(`${session.id}:${interaction.id}`);
      }
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { if (alive.current) setResponding(null); }
  }
  function inputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229 && !window.matchMedia('(max-width: 760px)').matches) { event.preventDefault(); void send(); }
  }

  return <section className="agent-workspace" aria-label={`${name} 会话`}>
    <div className="agent-scroll" ref={scroll} onScroll={() => { const node = scroll.current; if (node) followBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; }} aria-busy={loading}>
      <div className="agent-thread">
        {loading && !snapshot ? <div className="agent-loading" role="status">正在读取会话记录…</div> : snapshot && !snapshot.messages.length ? <div className="agent-welcome"><span className={`agent-welcome-symbol ${session.engine}`}><Icon name={session.engine === 'claude' ? 'spark' : 'code'} /></span><span className="eyebrow">{name} · 新会话</span><h1>从一个清楚的目标开始</h1><p>描述你的任务，{name} 会在这个项目中继续工作。</p><div className="welcome-project"><Icon name="folder" /><code>{session.initialCwd}</code></div></div> : snapshot ? <div className="agent-messages" role="log" aria-label="会话消息" aria-live="off">{snapshot.messages.map(message => <article className={`agent-message role-${message.role}`} key={message.id}><div className="message-avatar" aria-hidden="true">{message.role === 'user' ? '你' : <Icon name={message.role === 'system' ? 'info' : session.engine === 'claude' ? 'spark' : 'code'} />}</div><div className="message-content"><div className="message-author">{message.role === 'user' ? '你' : message.role === 'system' ? '会话提示' : name}{message.status === 'streaming' && <span className="stream-label">正在回复</span>}{message.status === 'interrupted' && <span className="stream-label">已中断</span>}</div><div className="message-text">{message.text || (message.status === 'streaming' ? '正在组织回复…' : '')}</div></div></article>)}</div> : null}
        {!!snapshot?.tools.length && <section className="agent-tools" aria-label="工具记录"><h2>工具记录 <span>{snapshot.tools.length}</span></h2>{snapshot.tools.map(tool => <details className="tool-record" key={tool.id}><summary><Icon name="terminal" /><b>{tool.title}</b><span className={`tool-state ${tool.state}`}>{tool.state === 'running' ? '执行中' : tool.state === 'failed' ? '未完成' : '已完成'}</span></summary><div className="tool-detail">{tool.detail || '暂无更多详情。'}</div></details>)}</section>}
        {busy && <div className="agent-activity" role="status"><i className={`dot ${online ? '' : 'quiet'}`} />{!online ? '连接已断开，等待重新连接' : stopping || session.state === 'stopping' ? '已请求停止，正在等待当前任务结束…' : waiting ? '等待你处理下方的确认事项' : sending ? '正在发送任务…' : `${name} 正在处理任务…`}</div>}
        {!loading && !snapshot && <div className="agent-empty-error"><p>暂时无法读取会话记录。</p><button className="secondary" disabled={!online} onClick={() => { void restore(); }}>重新读取</button></div>}
      </div>
    </div>
    <div className="agent-bottom">
      {(error || session.error) && <div className="agent-error" role="alert"><Icon name="info" /><span>{error || session.error}</span>{error && <button className="icon-button" onClick={() => setError('')} aria-label="关闭会话提示"><Icon name="close" /></button>}</div>}
      {!!snapshot?.interactions.length && <section className="interaction-stack" aria-label="待处理事项">{snapshot.interactions.map(interaction => <InteractionCard key={interaction.id} interaction={interaction} sessionId={session.id} disabled={!online || !canControl || !!responding || stopping || session.state === 'stopping' || interaction.runId !== session.runId} pending={responding === interaction.id} stale={interaction.runId !== session.runId} onAnswer={answer => { void respond(interaction, answer); }} />)}</section>}
      <form className="agent-composer" onSubmit={event => { void send(event); }}>
        <label className="sr-only" htmlFor={`message-${session.id}`}>发送给 {name} 的消息</label><textarea ref={composer} id={`message-${session.id}`} value={draft} onChange={event => changeDraft(event.target.value)} onKeyDown={inputKey} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} placeholder={!canControl ? '只读查看；可以在这里保留下一条任务草稿…' : waiting ? '先处理上方事项，也可以在这里保留下一条任务…' : `描述任务，或继续与 ${name} 讨论…`} rows={2} maxLength={MAX_AGENT_TEXT_BYTES} aria-invalid={!!draftError} aria-describedby={draftError ? `message-error-${session.id}` : undefined} disabled={sending} />
        <div className="composer-toolbar"><div className="composer-settings"><span className="composer-engine"><Icon name="folder" /><span>{name}</span><span>·</span><span>{sessionStateName(session)}</span></span>{session.engine === 'codex' && <label className="model-picker"><span className="sr-only">Codex 模型</span><select value={selectedModel} disabled={busy || !online} onChange={event => changeModel(event.target.value)} aria-label="Codex 模型" title="只影响当前会话；不会更改官方 CLI 配置"><option value="">官方 CLI 默认</option>{selectedModel && !models.some(model => model.id === selectedModel) && <option value={selectedModel}>{selectedModel}（当前选择）</option>}{models.map(model => <option value={model.id} key={model.id}>{model.label || model.id}{model.isDefault ? ' · 默认' : ''}</option>)}</select></label>}</div>{busy && !sending ? <button className="agent-stop" type="button" onClick={() => { void stop(); }} disabled={!online || !canControl || !session.runId || stopping || session.state === 'stopping'}><Icon name="stop" />{stopping || session.state === 'stopping' ? '正在停止…' : '停止任务'}</button> : <button className="agent-send" aria-label="发送消息" title="发送消息" disabled={!online || !canControl || busy || waiting || !snapshot || !draft.trim() || !!draftError}><Icon name="arrow" /></button>}</div>
      </form>
      {session.engine === 'codex' && <div className="model-feedback">{modelsLoading ? <span role="status">正在读取可用模型…</span> : modelsError ? <><span role="status">模型列表读取失败：{modelsError}</span><button type="button" onClick={() => { void loadModels(); }} disabled={!online || modelsLoading}>重试</button></> : !models.length ? <><span>暂无模型列表，可继续使用官方 CLI 默认。</span><button type="button" onClick={() => { void loadModels(); }} disabled={!online}>重新读取</button></> : null}</div>}
      {draftError && <p className="composer-validation" id={`message-error-${session.id}`} role="status">{draftError}</p>}
      <div className="composer-notes"><span className="desktop-input-hint">Enter 发送 · Shift + Enter 换行</span><span className="mobile-input-hint">回车换行 · 点击按钮发送</span><span>{!online ? '已离线 · 草稿保留在当前窗口' : !canControl ? '只读查看 · 接管后可发送' : bridge.kind === 'browser' ? '电脑端 · 本地项目' : '此电脑 · 本地项目'}</span></div>
    </div>
  </section>;
}

function InteractionCard({ interaction, sessionId, disabled, pending, stale, onAnswer }: { interaction: AgentInteraction; sessionId: string; disabled: boolean; pending: boolean; stale: boolean; onAnswer: (answer: AgentAnswer) => void }) {
  const cacheKey = `${sessionId}:${interaction.id}`;
  const [selected, setSelected] = useState<Record<string, string[]>>(() => answerDrafts.get(cacheKey) ?? {});
  const [custom, setCustom] = useState<Record<string, string>>(() => customAnswerDrafts.get(cacheKey) ?? {});
  const questions = interaction.questions ?? [];
  function choices(question: AgentQuestion) { return [...new Set([...ownValue(selected, question.id, []), ...(ownValue(custom, question.id, '').trim() ? [ownValue(custom, question.id, '').trim()] : [])])]; }
  const valid = interaction.kind !== 'question' || (questions.length > 0 && questions.every(question => choices(question).length > 0));
  function updateChoice(question: AgentQuestion, option: string) {
    const current = ownValue(selected, question.id, []);
    const next = { ...selected, [question.id]: question.multiple ? current.includes(option) ? current.filter(value => value !== option) : [...current, option] : [option] };
    setSelected(next); answerDrafts.set(cacheKey, next);
    if (!question.multiple) setCustom(previous => { const next = { ...previous, [question.id]: '' }; customAnswerDrafts.set(cacheKey, next); return next; });
  }
  return <div className={`interaction-card interaction-${interaction.kind}`}><div className="interaction-heading"><span className="interaction-symbol"><Icon name="info" /></span><div><h2>{interaction.title}</h2><span>{stale ? '此请求已不是当前任务，无法提交' : interaction.kind === 'permission' ? '需要你的许可' : interaction.kind === 'question' ? '需要补充信息' : '需要你处理'}</span></div></div>{interaction.detail && <div className="interaction-detail">{interaction.detail}</div>}
    {questions.map(question => <fieldset className="agent-question" key={question.id} disabled={disabled}><legend>{question.header && <span>{question.header}</span>}{question.question}{question.multiple && <small>可多选</small>}</legend><div className="question-options">{question.options.map(option => <label className={`question-option ${ownValue(selected, question.id, []).includes(option.label) ? 'chosen' : ''}`} key={option.label}><input type={question.multiple ? 'checkbox' : 'radio'} name={`${interaction.id}-${question.id}`} value={option.label} checked={ownValue(selected, question.id, []).includes(option.label)} onChange={() => updateChoice(question, option.label)} /><span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span></label>)}</div><label className="question-custom"><span>{question.options.length ? '补充或填写其他回答' : '你的回答'}</span><input type="text" value={ownValue(custom, question.id, '')} onChange={event => { const value = event.target.value; setCustom(previous => { const next = { ...previous, [question.id]: value }; customAnswerDrafts.set(cacheKey, next); return next; }); if (!question.multiple && value.trim()) { const next = { ...selected, [question.id]: [] }; setSelected(next); answerDrafts.set(cacheKey, next); } }} placeholder="输入你的回答" maxLength={10000} /></label></fieldset>)}
    <div className="interaction-actions">{interaction.actions.map(action => <button key={action} type="button" className={action === 'allow-once' || action === 'submit' ? 'primary' : 'secondary'} disabled={disabled || (action === 'submit' && !valid)} onClick={() => onAnswer(action === 'submit' ? { action, answers: Object.fromEntries(questions.map(question => [question.id, choices(question)])) } : { action })}>{pending ? '正在提交…' : actionNames[action]}</button>)}</div>
  </div>;
}
