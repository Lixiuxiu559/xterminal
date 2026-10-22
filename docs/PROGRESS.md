# 产品开发进度

更新：2026-10-22，试用版0.1.1。整体目标仍是三引擎桌面工作空间与手机内网直连；当前为开发版本，未完成最终产品验收。原型演示不计为产品实现。

| 里程碑 | 已实现与验证 | 剩余工作 |
| --- | --- | --- |
| M0 工程与风险 | Electron main/preload/utility Host、React/Vite、SQLite/PTY原生模块、两引擎真实短请求、真实TLS/WSS、Host/主进程强杀与进程回收 | 手机证书信任真机验收；进程监护固定版本兼容矩阵 |
| M1 桌面Shell | 真实PTY、键盘、中文、Ctrl+C、resize、快照、关窗保活和退出确认；390/768/1440px布局验证 | 长时间与复杂TUI压力、主进程至慢renderer流控 |
| M2 历史与恢复 | SQLite消息/原生上下文/运行投影、发送回执、创建幂等、重启中断不重发、同项目Agent锁、单端控制租约 | 历史分页、工具与审批历史的完整持久化、完整领域事件恢复协议 |
| M3 Agent | Codex app-server与Claude CLI stream-json；聊天/工具/审批/提问、停止确认、上下文恢复、Codex模型选择；真实桌面对话/工具/重启续聊6轮通过；权限/问题/停止四阶段夹具通过 | 真实模型全部交互分支与长期任务；引擎升级兼容矩阵 |
| M4 手机 | 默认关闭的HTTPS/WSS、私有IP选择、CA导出、一次性配对码、桌面批准、设备撤销、浏览器重连、显式接管；真实网络→Host→SQLite集成通过 | 手机安装信任证书、Safari/Chrome软键盘与后台重连、跨真实设备验收 |
| M5 首发 | 暖白/墨绿主题、深色、按需加载、未签名macOS arm64应用可构建 | 自有图标、签名/公证、独立安装包启动与资源压力验收 |

## 当前代码边界

- `apps/desktop`：OS能力、受限preload、Host监督与退出、原生公有CA证书导出。
- `apps/ui`：实际React界面、三引擎视图、桌面局域网管理、HTTPS浏览器配对与传输。
- `packages/host`：运行时参数校验、可信端身份、每会话串行、控制租约、Agent项目锁与引擎协调、LAN生命周期。
- `packages/storage`：v1 schema的SQLite单写者，设备只保存token hash。
- `packages/engines`：Shell真实PTY、Codex结构化stdio、Claude官方未修改CLI。
- `packages/lan`：HTTPS静态页面、Cookie设备认证、WSS领域RPC与广播、限流与有界队列。

局域网启动后若所选IP消失即停止共享，不自动换网卡。关闭共享撤销所有授权；重启默认关闭并撤销上次授权。撤销/过期释放控制权，不结束任务。配对码只在桌面开启/刷新响应出现，不向手机广播、不持久化明文。

## 最近验证

- `pnpm test`：82项领域/引擎/Host/SQLite/UI传输与辅助测试。
- `pnpm test:lan`：15项，含真实TLS/IP SAN、Origin/Host、配对/撤销/过期、SQLite集成、旧控制代际拒绝，以及撤销写失败重试与关闭等待。
- `pnpm typecheck`、`pnpm test:storage`、`pnpm build`通过；0.1.1已重新打包，包内资源GUI与原生模块检查通过（隔离harness，不替代独立安装/签名验收）。
- `pnpm smoke:desktop`：真实Electron SQLite/PTY、局域网管理页面、关窗保活与重启通过。窄屏截图来自桌面renderer，不是手机真机证据。
- `pnpm smoke:agent-desktop`：生产桌面协议夹具四阶段通过，包含Host强杀、离线禁写、退出及重启续聊。
- `pnpm smoke:agent-desktop --real --model gpt-6-astra --tools`：Claude与Codex各真实对话、限定文件工具任务与重启续聊，共6轮通过。
- `pnpm smoke:crash --codex`和`pnpm smoke:crash-early-stop`：Host/主进程强杀、PTY/stdin EOF竞态、忽略信号工具回收、无关canary存活、未知回执拒绝重放和早停未派发通过。
- 完整说明见 `docs/validation/2026-10-22-agent-desktop/README.md`、`docs/validation/2026-10-22-crash/README.md`；网络测试与限制见 `docs/validation/2026-10-22-lan/README.md`。

质量记录：0.1.1 开发与验收时没有 Git 基线，未宣称 diff-review 通过；本次整理后建立首个源码提交作为后续比较基线。对当前文件进行生命周期与权限边界复核，补齐旧控制权晚到响应、未加载仓储时关闭、撤销落盘失败重试与并发关闭等待。没有配置复杂度与突变工具，未运行相关审计。

## 继续顺序

1. 本轮Agent桌面端到端与Host崩溃恢复验收已通过；继续补长期真实任务和工具主动脱离进程组等边界。
2. 完成历史分页、慢消费者和完整恢复协议，增加长时间资源验证。
3. 真机安装CA与双端操作，验证移动浏览器输入、后台恢复及网络变化。
4. 完成图标、安装包GUI、签名/公证与首发验收。基础链路通过不等于最终产品完成。
