import readline from 'node:readline';
import assert from 'node:assert/strict';
let initialized = false;
let thread = 'thread-fixture';
let turn;
let count = 0;
let waiting = new Map();
let stubborn = false;
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const notify = (method, params) => write({ method, params });
const done = (status) => notify('turn/completed', { threadId: thread, turn: { id: turn, status, items: [] } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    const callback = waiting.get(frame.id);
    assert.ok(callback, 'response must preserve native request ID');
    waiting.delete(frame.id);
    callback(frame);
    return;
  }
  const { id, method, params } = frame;
  if (method === 'initialize') {
    assert.equal(params.clientInfo.name, 'xterminal');
    const response = JSON.stringify({ id, result: { userAgent: 'fixture' } }) + '\n';
    process.stdout.write(response.slice(0, 7));
    setTimeout(() => process.stdout.write(response.slice(7)), 5);
  } else if (method === 'initialized') { initialized = true; }
  else if (method === 'account/read') {
    assert.equal(initialized, true);
    assert.equal(params.refreshToken, false);
    write({ id, result: { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'do-not-emit@example.invalid' } } });
  } else if (method === 'thread/start' || method === 'thread/resume') {
    assert.equal(params.approvalPolicy, 'on-request');
    assert.equal(params.approvalsReviewer, 'user');
    assert.equal(params.sandbox, 'workspace-write');
    if (method === 'thread/resume') thread = params.threadId;
    write({ id, result: { thread: { id: thread } } });
  } else if (method === 'turn/start') {
    const scenario = params.input[0].text;
    assert.notEqual(scenario, 'never-submit', 'an early stop must not submit the prompt');
    turn = `turn-${++count}`;
    const binding = { threadId: thread, turnId: turn };
    // Early event before the acceptance response tests ordering and run binding.
    notify('item/agentMessage/delta', { ...binding, itemId: 'msg', delta: 'initial' });
    const accepted = { id, result: { turn: { id: turn, status: 'inProgress', items: [] } } };
    if (scenario === 'early-interrupt') setTimeout(() => write(accepted), 100);
    else write(accepted);
    notify('item/agentMessage/delta', { ...binding, threadId: 'other', itemId: 'evil', delta: 'wrong-thread' });
    notify('item/agentMessage/delta', { ...binding, turnId: 'old', itemId: 'evil', delta: 'wrong-turn' });
    if (scenario === 'approval') {
      waiting.set(42, (response) => {
        assert.equal(response.result.decision, 'accept');
        notify('item/completed', { ...binding, item: { type: 'agentMessage', id: 'msg', text: 'final replacement' } });
        done('completed');
      });
      write({ id: 42, method: 'item/commandExecution/requestApproval', params: { ...binding, itemId: 'cmd', command: 'printf test', startedAtMs: 1 } });
    } else if (scenario === 'file-deny' || scenario === 'file-cancel') {
      waiting.set('native-file-id', (response) => {
        assert.equal(response.result.decision, scenario === 'file-deny' ? 'decline' : 'cancel');
        done(scenario === 'file-deny' ? 'completed' : 'interrupted');
      });
      write({ id: 'native-file-id', method: 'item/fileChange/requestApproval', params: { ...binding, itemId: 'patch', startedAtMs: 1, reason: 'test file write', grantRoot: '/tmp' } });
    } else if (scenario === 'pending') {
      waiting.set('native-pending-id', (response) => { assert.equal(response.error.code, -32800); });
      write({ id: 'native-pending-id', method: 'item/commandExecution/requestApproval', params: { ...binding, itemId: 'pending', startedAtMs: 1 } });
    } else if (scenario === 'stubborn') {
      stubborn = true;
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    } else if (scenario === 'question' || scenario === 'question-proto') {
      const questionId = scenario === 'question-proto' ? '__proto__' : 'target';
      waiting.set('native-question-id', (response) => {
        assert.deepEqual(Object.keys(response.result.answers), [questionId]);
        assert.deepEqual(response.result.answers[questionId], { answers: ['A'] }); done('completed');
      });
      write({ id: 'native-question-id', method: 'item/tool/requestUserInput', params: { ...binding, itemId: 'question', isBlocking: true, questions: [{ id: questionId, header: '目标', question: '选哪个？', options: [{ label: 'A', description: '选项A' }] }] } });
    } else if (scenario === 'unknown') {
      waiting.set('unknown', (response) => { assert.equal(response.error.code, -32601); done('failed'); });
      write({ id: 'unknown', method: 'some/future/approval', params: binding });
    } else if (scenario === 'exit') { process.exit(7); }
    else if (scenario === 'oversize') { process.stdout.write('x'.repeat(5 * 1024 * 1024)); }
    else if (scenario === 'complete') {
      setTimeout(() => done('completed'), 20);
    }
  } else if (method === 'turn/interrupt') {
    assert.equal(params.turnId, turn);
    assert.equal(params.threadId, thread);
    write({ id, result: {} });
    setTimeout(() => done('interrupted'), 60);
  } else { throw new Error(`unexpected method ${method}`); }
});
process.stdin.on('end', () => { if (!stubborn) process.exit(0); });
