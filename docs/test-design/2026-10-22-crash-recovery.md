# 崩溃恢复验收设计

依据：PRD/ARCHITECTURE 中本机任务、显式恢复、不自动重发、单项目 Agent 写锁、退出停止自有进程的约定。本次不模拟模型成功，不访问用户项目/任务。沿用 Node test、Electron utilityProcess 和临时目录 smoke，无新测试框架。

| 编号 | 场景与操作 | 预期断言 | 验证入口 |
| --- | --- | --- | --- |
| C01 | Electron utility Host 启动真实 PTY，执行仅本次创建的长驻子命令，强制 SIGKILL Host | 本次 PTY 与同组工作进程结束；独立无关 canary 仍存活 | smoke-crash（真实进程） |
| C02 | 应用主进程强制 SIGKILL，Host 生命管道断开 | Host 结束、引擎工作进程结束；不启动替代任务 | smoke-crash（真实进程） |
| C03 | 活跃 run、streaming 消息及 dispatched receipt 已持久化时强杀，再用同 DB 启动新 Host | run/message interrupted，receipt outcome_unknown；重放同命令拒绝，消息不重复 | smoke-crash（SQLite 边界，注入无模型在途记录） |
| C04 | C03 后明确创建新 commandId | 旧项目锁不跨 Host 阻塞新命令；只执行新请求 | host 恢复边界测试（fixture runtime，不能算真实 Agent） |
| C05 | 监护初始化失败/目标进程组与 Host 同组/出生核验失效 | 拒绝保护无效的启动；不对不明 PID 或用户进程发送信号 | process-guard 单测 |
| C06 | 正常结束及守护收到 Host EOF | 守护自身退出；无长期 detached 监护壳遗留 | smoke-crash 与 process-guard 单测 |

限制：工具自行脱离进程组（setsid）、机器断电、内核失效不属于本次本机进程组监护保证。真实付费 Agent 桌面交互由独立验收覆盖；此处的在途 Agent 数据记录是恢复边界输入，不能代替真实模型回合。
