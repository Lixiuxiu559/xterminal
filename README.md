# XTerminal

当前试用版：**0.1.1（macOS Apple Silicon）**。

面向本地开发的桌面工作空间。会话创建时固定选择 Claude Code、Codex 或 Shell，目标是在手机上通过内网连接电脑上的同一会话。正式产品名待定。

## 当前可运行的能力

已实现 Electron 桌面应用、独立会话 Host、三引擎会话与内网连接：

- 通过系统窗口选择项目目录，搜索、创建和重命名会话。
- 交互式 PTY，保持 cwd / 环境，支持中文、Ctrl+C、尺寸调整及终端快照。
- 切换会话或关闭全部窗口时继续运行，从菜单 / 托盘恢复窗口。
- 显式退出列出活动终端，确认后等待进程实际结束并保存记录。
- SQLite 保存项目、会话与运行记录；重启后不自动启动旧 PTY 或重发命令。
- 浅深主题与桌面 / 窄屏布局。
- Claude Code 与 Codex 的结构化聊天、工具状态、权限与提问卡片、停止和原生上下文恢复；两个引擎的真实桌面对话、限定文件工具任务和重启续聊均已通过。
- Codex 可读取官方模型列表并明确选择本轮模型；沿用官方 CLI 默认时不会静默替换或自动重试。
- 默认关闭的局域网 HTTPS/WSS，电脑批准配对、七天设备授权、设备撤销和显式接管；其他端只读。

当前是开发版本。Host/应用强杀、进程监护竞态和重启恢复已完成本轮验收。真实 TLS/WSS 与 Host/SQLite 集成已通过，手机证书安装与移动浏览器软键盘仍待真机验收；包内资源 GUI 已验证，独立安装包启动、签名和公证尚未验收。`prototype/` 是设计演示，运行应用使用 `apps/ui`。

## 运行

环境：macOS arm64（本轮实际验证）、Node.js 24+、pnpm 10.33.0。编译原生模块需要 Xcode Command Line Tools。

```sh
pnpm install
pnpm rebuild:native
pnpm build
pnpm start
```

开发时可用 `pnpm dev` 启动 loopback Vite 和桌面应用；主进程 / Host 改动后需重新启动开发命令。正式页面使用打包资源的 `app://`，不依赖开发服务器。

首次打开：新建会话 → 选择本地目录 → 选择引擎 → 创建。Shell 需明确启动；Agent 通过输入框发送消息。本机需事先安装并登录官方 CLI：Claude Code 当前验证版本 2.1.304，Codex 当前验证版本 0.157.0。Claude 不匹配的版本会显示不可用。关闭窗口会保留应用与进程；请从 XTerminal 菜单明确退出。

## 手机连接

电脑与手机连接同一内网，在桌面左下角打开“连接手机”，选择私有 IP 后开启。导出本地 CA 公有证书，通过你认可的方式传到手机，在手机系统安装并启用信任，再打开显示的 HTTPS 地址。电脑不对公网开放，也不提供证书信任绕过。

在手机输入配对码并申请，回到电脑核对设备名称后允许。进入会话后点击“接管操作”获得控制权；旧端立即只读。断线不会重发未确认的写操作。撤销设备、关闭共享或重启应用后需要重新配对。电脑休眠时不可连接。

## 验证与本地打包

```sh
pnpm typecheck
pnpm test
pnpm test:storage
pnpm test:lan
pnpm build
pnpm smoke:desktop
pnpm smoke:agent-desktop
pnpm smoke:crash --codex
pnpm smoke:crash-early-stop
```

`smoke:desktop` 启动真实 Electron，使用隔离的临时数据 / 项目目录，运行受控 Shell 命令、窗口关闭恢复、键盘与重启检查，不调用模型、不读取引擎凭据。测试过程会短暂打开和调整窗口；报告与截图保存在 `docs/validation/2026-10-22-desktop/`。失败保留临时数据供定位，成功清理该次临时目录。

`test:lan` 在临时 loopback 端口运行真实 TLS/WSS 测试，不调用模型。`test` 使用协议夹具，也不调用模型。真实模型验证需明确运行以下脚本，会使用本机已有登录与模型额度：

```sh
pnpm smoke:codex-turn --model gpt-6-astra
pnpm smoke:claude-turn
pnpm smoke:agent-desktop --real --model gpt-6-astra --tools
```

生成未签名的本地应用目录：

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac
node scripts/check-native-package.mjs
node scripts/smoke-desktop.mjs --packaged
```

输出：`release/mac-arm64/XTerminal.app`。第二条命令使用安装包的 Electron 运行时检查 SQLite 与 PTY；第三条通过隔离 harness 验证包内主进程、界面与 Host，不替代独立安装包启动、签名、公证或真机验收。当前尚未准备公开分发版本。

本地试用包与操作步骤见 [试用说明](docs/TRYOUT.md)，版本变更见 [更新记录](CHANGELOG.md)。`release/`、`dist/`、依赖和测试临时目录不提交；源码、lockfile、设计原型及验收文档纳入版本控制。

## 文档

- [产品需求](docs/PRD.md) · [设计规范](docs/DESIGN.md)
- [系统架构](docs/ARCHITECTURE.md) · [交互架构图](docs/architecture/system.html)
- [客户端协议](docs/architecture/PROTOCOL.md) · [实施与验收计划](docs/IMPLEMENTATION.md)
- [开发进度与剩余工作](docs/PROGRESS.md)
- [引擎接入调研](docs/research/2026-10-22-engine-integration.md)
- [桌面 Shell 验证记录](docs/validation/2026-10-22-desktop/README.md)
- [Agent桌面端到端](docs/validation/2026-10-22-agent-desktop/README.md) · [崩溃恢复验收](docs/validation/2026-10-22-crash/README.md)
- [设计原型](prototype/README.md)
