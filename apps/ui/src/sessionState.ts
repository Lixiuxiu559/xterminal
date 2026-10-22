import type { AppSession } from '../../../packages/protocol/src/desktop';

export const stateNames: Record<AppSession['state'], string> = { idle: '尚未启动', starting: '正在启动', running: '运行中', waiting: '待确认', stopping: '正在结束', interrupted: '运行已中断', exited: '已结束', error: '启动失败' };

export function sessionStateName(session: AppSession): string {
  if (session.engine === 'shell') return stateNames[session.state];
  if (session.state === 'idle') return '就绪';
  if (session.state === 'stopping') return '正在停止';
  if (session.state === 'error') return '任务出错';
  return stateNames[session.state];
}
