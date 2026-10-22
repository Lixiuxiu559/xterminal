import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSendError, agentTextError, defaultSessionTitle, ownValue, titleError, modelTurnParameters, restoreModelSelection, ownsSessionControl } from './uiValidation.ts';

test('provider question IDs never use inherited values as answers', () => {
  const selected: Record<string, string[]> = {};
  const custom: Record<string, string> = {};
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(ownValue(selected, id, []), []);
    assert.equal(ownValue(custom, id, ''), '');
  }
  const answered = { ...selected, ['__proto__']: ['明确回答'] };
  assert.deepEqual(ownValue(answered, '__proto__', []), ['明确回答']);
  assert.equal(Object.getPrototypeOf(answered), Object.prototype);
});
test('message limit is 60,000 UTF8 bytes including Chinese and emoji', () => {
  assert.equal(agentTextError('a'.repeat(60_000)), '');
  assert.equal(agentTextError('中'.repeat(20_000)), '');
  assert.equal(agentTextError('😀'.repeat(15_000)), '');
  assert.match(agentTextError('中'.repeat(20_001)), /60,003.*60,000/);
  assert.match(agentTextError('😀'.repeat(15_001)), /60,004.*60,000/);
});
test('clear host rejection differs from an uncertain transport result', () => {
  assert.match(agentSendError(Object.assign(new Error('项目正在执行'), { code: 'PROJECT_BUSY' })), /^消息未发送：/);
  assert.match(agentSendError(new Error('连接断开')), /^发送结果未确认/);
  assert.match(agentSendError(Object.assign(new Error('未知错误'), { code: 'INTERNAL_ERROR' })), /^发送结果未确认/);
});
test('default titles follow the fixed engine', () => {
  assert.equal(defaultSessionTitle('shell'), '新的 Shell 会话');
  assert.equal(defaultSessionTitle('claude'), '新的 Claude Code 会话');
  assert.equal(defaultSessionTitle('codex'), '新的 Codex 会话');
});
test('title length agrees with current Host UTF16 limits', () => {
  assert.equal(titleError('中'.repeat(60)), '');
  assert.notEqual(titleError('中'.repeat(61)), '');
  assert.equal(titleError('😀'.repeat(30)), '');
  assert.notEqual(titleError('😀'.repeat(31)), '');
  assert.notEqual(titleError('a\0b'), '');
});

test('only an explicit Codex model selection changes turn parameters', () => {
  assert.deepEqual(modelTurnParameters('codex', ''), {});
  assert.deepEqual(modelTurnParameters('codex', 'provider-model-id'), { model: 'provider-model-id' });
  assert.deepEqual(modelTurnParameters('claude', 'provider-model-id'), {});
});
test('late model snapshots never replace a user selection, including official default', () => {
  assert.equal(restoreModelSelection('', 'restored-model', false), 'restored-model');
  assert.equal(restoreModelSelection('old-model', null, false), '');
  assert.equal(restoreModelSelection('new-model', 'old-model', true), 'new-model');
  assert.equal(restoreModelSelection('', 'old-model', true), '');
  assert.equal(restoreModelSelection('new-model', undefined, false), 'new-model');
});

test('only the principal holding the current lease can operate a session', () => {
  const lease = { principalId: 'desktop', hostInstanceId: 'host-1', generation: 2, expiresAtMs: Date.now() + 20_000 };
  assert.equal(ownsSessionControl({ control: lease }), true);
  assert.equal(ownsSessionControl({ control: lease }, 'device:phone'), false);
  assert.equal(ownsSessionControl({ control: { ...lease, principalId: 'device:phone' } }, 'device:phone'), true);
  assert.equal(ownsSessionControl({ control: { ...lease, principalId: 'device:phone' } }), false);
  assert.equal(ownsSessionControl({ control: null }), false);
  assert.equal(ownsSessionControl({}), false);
  assert.equal(ownsSessionControl(undefined), false);
});
