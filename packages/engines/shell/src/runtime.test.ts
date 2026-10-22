import test from 'node:test';
import { runShellRuntimeSmoke } from './smoke.ts';

test('真实 PTY、输入约束、Ctrl+C、快照屏障与实际退出', { timeout: 45000 }, async () => {
  await runShellRuntimeSmoke();
});
