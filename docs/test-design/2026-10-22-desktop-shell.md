# 桌面 Shell 首条链路测试设计

依据：ARCHITECTURE 第 4、6、8、10 节与 IMPLEMENTATION M0/M1。已有设施为 Node test 和 Python SQLite 检查；本轮沿用 Node test，原生模块与窗口生命周期使用实际 Electron smoke，不用 mock 代替。

| 编号 | 规则与操作 | 必须观察的结果 | 验证入口 |
| --- | --- | --- | --- |
| D01 | 添加临时目录，再用相同 realpath 添加 | 仅一个项目；不存在目录拒绝 | 存储 / Host |
| D02 | 创建 Shell、重命名、重新打开数据库 | 标题持久化，engine/cwd 不变，旧 revision 重命名被拒绝 | 存储 |
| D03 | 同一个会话重复启动 | 只有一个活跃 PTY；退出后可明确启动新 run | Host + PTY |
| D04 | 同一个 PTY 执行 cd 后 pwd，输出中文 | cwd 保持、Unicode 正确；不是逐条 spawn | 实际 PTY |
| D05 | 执行持续输出命令后输入 Ctrl+C | 前台命令中断，Shell 仍可接收下一条命令 | 实际 PTY |
| D06 | 快照期间持续输出，再按 watermark 合并 | 快照已解析输出不重复，后续帧不丢失 | 实际 PTY + xterm |
| D07 | 旧 run/epoch 输入、重复 inputId、超长数据、非法尺寸 | 拒绝陈旧/非法帧，相同输入最多写入一次 | Host + PTY |
| D08 | 关窗并重新打开，再显式退出 | 关窗 PTY 存活、恢复同一 run；退出回收受控子进程 | Electron smoke |
| D09 | 重新启动应用 | 项目与会话存在，旧活跃 run 标中断，不能自动重发输入或启动 | 存储 + Host |
| D10 | 非可信 frame、未知 IPC、远程页面导航 | 不获得本机 bridge 能力，不执行命令 | 桌面边界检查与 smoke |

桌面阶段只有本机可信端；不能用这一阶段的 IPC 测试替代未来手机认证与控制权测试。尚未实现的用例保留缺口，不据此称完整 M1 通过。

退出集成审查补充：D11 在有已受理启动命令时请求退出准备，应先排空队列、冻结新操作，取消后允许继续；D12 注入运行结束记录写入失败，进程终态仍准确且关闭不得报告成功，修复存储后可重试落盘；D13 主动结束的 SIGHUP 非零码应持久化为 exited。承接入口为 Host 的 Node test，PTY 测试夹具只隔离退出/存储错误，真实子进程清理仍由 Electron smoke 证明。

Agent 开工用例（依据架构第6–8节）：A01 同项目两个Agent轮次仅一个启动，不同项目独立；A02同commandId的已接收用户消息不重复执行，冲突payload拒绝；A03 delta与最终消息按稳定ID覆写，重启仍有用户与最终回复；A04权限/提问只回答当前run的一次挂起请求，旧卡片/重复回答拒绝；A05停止请求后仍为stopping直到原生结束事件；A06未知协议请求不自动批准，分片/异常/退出能稳定收敛；A07恢复使用明确原生ID，不按目录续接其他会话。默认测试用受控SDK/子进程夹具；本机initialize/account检查不等于真实轮次验收；真实模型smoke须单独记录。

## LAN与控制权集成补充

| 场景 | 预期 | 验证位置 |
| --- | --- | --- |
| 默认启动/重启 | 不监听LAN；撤销上次设备授权，不恢复旧Cookie | Host LAN controller、真实桌面smoke |
| 开启共享 | 仅选当前私有IP；配对码只出现在本地开启/刷新响应 | lan-controller.test.ts |
| 手机申请与桌面批准 | 正确码、原申请方Cookie与批准均不可缺少；单次领取设备授权 | gateway.test.ts |
| 双端接管 | 新设备lease生效，旧端stamp拒绝；只读端不能隐式抢占 | Host integration、BrowserTransport tests |
| 设备撤销/过期 | 连接关闭、控制权释放，电脑任务继续 | host-integration.test.ts |
| 关闭与保存失败 | 先加载仓储，等待并发撤销落盘；读写失败可重试，不假装已保存 | lifecycle.test.ts |
| 断线恢复 | 不重发输入/消息；先监听后恢复快照，晚到响应不能恢复旧lease | browserTransport.test.ts |
| 真机 | 用户安装信任CA后双端输入、软键盘、后台恢复 | 待真机验收，自动化测试不能替代 |
