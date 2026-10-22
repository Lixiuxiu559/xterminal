import assert from 'node:assert/strict';
import test from 'node:test';
import { assertControl, assertFixedEngine, grantControl, PolicyError, transitionAgent } from './session-policy.ts';
import type { SessionIdentity } from '../../protocol/src/index.ts';

function errorCode(code: string) {
  return (error: unknown) => error instanceof PolicyError && error.code === code;
}
const session: SessionIdentity = { id: 's1', projectId: 'p1', engine: 'claude', initialCwd: '/project' };

test('F01: 已有会话拒绝切换引擎，同引擎操作不改变身份', () => {
  assert.throws(() => assertFixedEngine(session, 'codex'), errorCode('SESSION_ENGINE_IMMUTABLE'));
  assert.throws(() => assertFixedEngine(session, 'shell'), errorCode('SESSION_ENGINE_IMMUTABLE'));
  assert.doesNotThrow(() => assertFixedEngine(session, 'claude'));
  assert.equal(session.engine, 'claude');
});
test('F02: 停止请求后必须等待引擎确认', () => {
  assert.equal(transitionAgent('idle', 'start_requested'), 'starting');
  assert.equal(transitionAgent('starting', 'engine_started'), 'running');
  assert.equal(transitionAgent('running', 'stop_requested'), 'stopping');
  assert.equal(transitionAgent('stopping', 'stop_requested'), 'stopping');
  assert.equal(transitionAgent('stopping', 'stop_confirmed'), 'idle');
});
test('F03: 提问、回答和轮次结束具有独立状态', () => {
  assert.equal(transitionAgent('running', 'input_requested'), 'waiting');
  assert.equal(transitionAgent('waiting', 'input_resolved'), 'running');
  assert.equal(transitionAgent('running', 'turn_completed'), 'idle');
});
test('F04: 活跃轮次进程丢失后中断，不自动重跑', () => {
  for (const state of ['starting', 'running', 'waiting', 'stopping'] as const) {
    assert.equal(transitionAgent(state, 'process_lost'), 'interrupted');
  }
  assert.equal(transitionAgent('idle', 'process_lost'), 'idle');
});
test('F05: 恢复上下文回到空闲，不自动启动新任务', () => {
  assert.equal(transitionAgent('interrupted', 'restore_requested'), 'starting');
  assert.equal(transitionAgent('starting', 'context_restored'), 'idle');
});
test('F06: 拒绝乱序回答和停止后的晚到提问', () => {
  assert.throws(() => transitionAgent('idle', 'input_resolved'), errorCode('INVALID_TRANSITION'));
  assert.throws(() => transitionAgent('stopping', 'input_requested'), errorCode('INVALID_TRANSITION'));
  assert.throws(() => transitionAgent('interrupted', 'engine_started'), errorCode('INVALID_TRANSITION'));
});
test('F07: 手机接管后电脑的旧控制权失效', () => {
  const desktop = grantControl(null, 'host-a', 'desktop', 0);
  const phone = grantControl(desktop, 'host-a', 'phone', 100);
  assert.equal(phone.generation, 2);
  assert.throws(() => assertControl(phone, 'desktop', desktop, 101), errorCode('STALE_CONTROL'));
  assert.doesNotThrow(() => assertControl(phone, 'phone', phone, 101));
});
test('F08: 控制权到期的精确边界', () => {
  const lease = grantControl(null, 'host-a', 'desktop', 0, 15_000);
  assert.doesNotThrow(() => assertControl(lease, 'desktop', lease, 14_999));
  assert.throws(() => assertControl(lease, 'desktop', lease, 15_000), errorCode('CONTROL_REQUIRED'));
});
test('F09: 新 Host 即使 generation 相同也不接受旧 stamp', () => {
  const before = grantControl(null, 'host-a', 'desktop', 0);
  const after = grantControl(before, 'host-b', 'desktop', 100);
  assert.equal(before.generation, after.generation);
  assert.throws(() => assertControl(after, 'desktop', before, 101), errorCode('STALE_CONTROL'));
  assert.doesNotThrow(() => assertControl(after, 'desktop', after, 101));
});
test('F10: 非法时间和空主体不能形成控制租约', () => {
  assert.throws(() => grantControl(null, 'host-a', '', 0), errorCode('INVALID_LEASE'));
  assert.throws(() => grantControl(null, 'host-a', 'desktop', 0, 0), errorCode('INVALID_LEASE'));
  assert.throws(() => grantControl(null, 'host-a', 'desktop', NaN), errorCode('INVALID_LEASE'));
  assert.throws(() => grantControl(null, 'host-a', 'desktop', Number.MAX_SAFE_INTEGER), errorCode('INVALID_LEASE'));
  assert.throws(() => assertControl(null, 'desktop', { hostInstanceId: 'a', generation: 1 }, NaN), errorCode('INVALID_LEASE'));
});
