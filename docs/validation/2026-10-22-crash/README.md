# 崩溃恢复验收

版本：0.1.1。macOS arm64，Electron 45.0.0 / Node 24.22.0，node-pty 1.1.0。

## 本轮已通过

- `pnpm smoke:crash --codex`：真实Electron utility Host启动真实PTY、stdio根进程及工具子进程、官方Codex app-server（只初始化，不调用模型），分别强制SIGKILL Host和应用主进程。
- stdio工具自行安装忽略HUP/TERM处理器后写就绪标记。监护等待生命管道EOF，核验出生时间与进程组，TERM后升级KILL；测试所建引擎/工具/监护进程消失，无关canary保持存活。
- Agent监护继承stdin写FD、Shell监护持有PTY master，避免Host先死后根进程先EOF/HUP退出导致无法核验后代的竞态。
- 重启后run和已持久化streaming消息为interrupted，未确认回执为outcome_unknown；同commandId经Host领域入口重放得到COMMAND_OUTCOME_UNKNOWN，不重复执行。
- `pnpm smoke:crash-early-stop`：真实本地子进程与生产监护，但模型传输为夹具。监护就绪延迟期间停止不会发送旧消息，只有随后明确的新任务被发送；同组目标/无效管道FD被拒绝。
- `pnpm test`中的C04：恢复后旧命令不重放、明确新命令可取得项目锁；引擎异常退出后状态和锁释放。Claude同步guard构造失败/缺少FD的真实子进程均等到实际退出后报告失败。
- `pnpm smoke:agent-desktop`的crash/crash-restart：生产主进程按自身metrics定位Host并核验创建时间后强杀；页面离线且禁写、不自动重启；应用可以正常退出，重新启动保留中断历史并可明确续聊同一原生上下文。

证据：[Host强杀](host.json)、[应用强杀](application.json)、[监护延迟早停](early-stop.json)、[生产桌面离线](../2026-10-22-agent-desktop/fixture/crash.json)、[生产桌面恢复](../2026-10-22-agent-desktop/fixture/crash-restart.json)。

## 修正与边界

修正Host已死时退出流程没有异步等待、在before-quit内再次app.quit导致重入卡住的问题，改为下一事件循环退出。消息增量有50ms合并窗口；故障注入等待SQLite已提交边界，验收保证已提交历史恢复，不能声称任意时刻尚在内存的末尾字符必然保留。

监护只处理当前进程存活时建立并核验的子树/进程组，不按历史PID日志或进程名盲杀。实现依赖固定Node/Electron管道FD和node-pty内部master FD；不兼容时阻止派发。当前只在macOS arm64验收。

本轮保障Host/应用崩溃后的受控进程回收。引擎自身先于Host自主退出后遗留的独立工具、主动daemonize/setsid脱离子树、机器断电不属于该回收保证；引擎异常退出的状态/锁恢复与工具清理是不同用例，不混称已通过。工具进程不因取消而自动回滚已写文件。

独立文件级复核报告的两项失败路径均已修正并补测试；无Git基线，未宣称diff-review通过。未配置复杂度/突变工具，未伪造相关审计结果。
