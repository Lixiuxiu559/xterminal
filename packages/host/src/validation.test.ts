import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from './validation.ts';
const request = (method: string, params: unknown) => ({ id: 'test', method, params });
test('D10: 领域入口拒绝未知方法、缺失身份、额外字段和过大请求', () => {
  assert.throws(() => validateRequest(request('project.add', { path: '/' })), /不支持/);
  assert.throws(() => validateRequest({ method: 'bootstrap', params: {} }), /id/);
  assert.throws(() => validateRequest(request('session.create', { projectId: 'p', engine: 'shell', title: 'x', commandId: 'c', cwd: '/' })), /不支持/);
  assert.throws(() => validateRequest(request('bootstrap', [])), /对象/);
  assert.throws(() => validateRequest(request('session.create', { projectId: 'p', engine: 'other', title: 'x', commandId: 'c' })), /引擎/);
});
test('D07: 输入按 UTF-8 字节限制，身份不可缺失，尺寸必须为范围内整数', () => {
  const input = { sessionId: 's', runId: 'r', terminalEpoch: 'e', inputId: 'i', data: 'pwd\r' };
  assert.equal(validateRequest(request('shell.input', input)).method, 'shell.input');
  assert.throws(() => validateRequest(request('shell.input', { ...input, data: '中'.repeat(6000) })), /过长/);
  assert.throws(() => validateRequest(request('shell.input', { ...input, runId: '' })), /runId/);
  for (const [cols, rows] of [[1, 24], [80, 201], [80.5, 24], [Infinity, 24]]) {
    assert.throws(() => validateRequest(request('shell.start', { sessionId: 's', cols, rows })), /范围/);
  }
  assert.equal(validateRequest(request('shell.start', { sessionId: 's', cols: 500, rows: 200 })).method, 'shell.start');
});
test('D02: 重命名必须携带正整数版本，创建不能包含引擎切换字段', () => {
  assert.throws(() => validateRequest(request('session.rename', { sessionId: 's', title: 'new', expectedRevision: 0 })), /范围/);
  assert.throws(() => validateRequest(request('session.rename', { sessionId: 's', title: 'new', expectedRevision: 1, engine: 'codex' })), /不支持/);
  assert.throws(() => validateRequest(request('session.create', { projectId: 'p', engine: 'shell', title: ' ', commandId: 'c' })), /title/);
});
