# 引擎与运行时接入调研

日期：2026-10-22\
方式：官方文档、官方源码、只读本机 CLI 帮助及 Codex schema；未运行实际模型任务

本文区分已观察事实、架构推断与尚未验证事项。项目当前没有 Git 仓库，这份报告及其他架构文件均为本地未跟踪文件。

## 已观察事实

| 主题 | 证据 | 结论与置信度 |
| --- | --- | --- |
| 当前项目 | 调研开始时仅有 docs/ 与 prototype/；设计阶段随后新增 workspace、协议类型、状态策略及基础检查脚本 | 已有基础契约，尚无可运行桌面应用、Host 或真实引擎适配器；高 |
| 本机 Claude Code | `claude --version` / `--help` | 2.1.304，提供结构化输入输出、恢复等选项；高 |
| 本机 Codex | `codex --version` / app-server schema | 0.157.0，schema 在本机 `/private/tmp/xterminal-codex-schema/`；高 |
| Claude 持续会话 | [官方 Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) | SDK 可持续接收输入并输出结构化结果；高 |
| Claude 交互 | [官方 user-input](https://code.claude.com/docs/en/agent-sdk/user-input) | 权限和问题需要独立处理，不能只当普通聊天；高 |
| Claude 恢复 | [官方 sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | 应绑定明确的原生 session ID；高 |
| Codex 产品集成 | [OpenAI Docs: app-server](https://learn.chatgpt.com/docs/app-server) | stdio 是适合本机服务接入的双向控制接口；高 |
| Electron 后台服务 | [官方 utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) | 主进程可启动独立 Node 服务并通过 MessagePort 通信；高 |
| 原生模块 | [官方 Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) | 开发机 Node ABI 不等于 Electron ABI，需打包验证；高 |
| PTY | [microsoft/node-pty](https://github.com/microsoft/node-pty) | 可用于交互终端，支持本地读写与尺寸控制；高 |
| 终端流控 | [xterm.js flowcontrol](https://xtermjs.org/docs/guides/flowcontrol/) | 高速输出需要水位与反压；高 |
| 帧缓冲恢复 | [官方 addon-serialize](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize) | 有序列化能力，但不能据此承诺所有 TUI 完整恢复；高 / 覆盖范围待测 |

## Codex 本机 schema 的关键差异

本机 ThreadStartParams 中 sandbox 的值为 `read-only` / `workspace-write` / `danger-full-access`。不能将其他结构里的 `workspaceWrite` 混入此字段。

提问方法是 `item/tool/requestUserInput`，本机 schema 要求 `isBlocking`；`autoResolutionMs` 已废弃。`turn/interrupt` 同时需要 threadId 与 turnId。服务端 request 必须保留 ID 回答，不能按 notification 丢弃。

本机 approvalsReviewer 的 auto_review 描述涉及自动审查代理。首版采用 user，避免额外引入自动审批行为。

这些差异说明：适配器应按已验证 CLI 生成类型与测试夹具，并在升级时跑兼容性测试。线上示例不能替代本机契约。

## 认证证据与限制

Claude 的 [SDK Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)采用 API key / provider；[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)分别讨论运行未修改官方 binary 与第三方 SDK 的认证用途。不能由此推导“任何 SDK 版本都可无条件沿用已有订阅”。

Codex 的 [app-server 认证章节](https://learn.chatgpt.com/docs/app-server#auth-endpoints)与 [Sign in with ChatGPT 集成](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)区分本地/开源集成和其他发布形式。

设计结论：用户通过官方引擎配置自己的认证，产品不代收、储存或向手机转发凭据。既有认证兼容性在 M0 实测；未来商业化前重新核对适用条件。这是接入边界说明，不构成法律结论。

## 架构推断

- 统一 Host 可避免手机断线带走引擎进程；其可靠性来自进程所有权设计，不是 UI 页面常驻。
- SDK 与 app-server 均提供结构化交互，因此没有必要通过终端屏幕识别重建 Agent 对话。
- 首版每会话独立引擎子进程较易界定故障范围；资源成本仍需要实测。
- 桌面 IPC 与手机 TLS 入口分离，可以明确本机专属操作边界。

以上是由事实支持的设计取舍，尚不是性能或可靠性测试结果。

## 必须进入 M0 的未确认项

1. 选定 Claude SDK 与本机 CLI、用户实际认证的组合；ExitPlanMode 及挂起交互中断语义。
2. Codex 进程退出后的 thread 恢复、账户状态与中断通知顺序。
3. Electron utility process 中 node-pty 与 SQLite 的 ABI、签名及打包位置。
4. 服务端 xterm headless + serialize 对颜色、光标、resize、alternate screen 的实际覆盖。
5. 同时运行多个 Agent 子进程的内存、启动时间与文件交互。
6. 手机 Safari / Chrome 的本地 HTTPS 信任引导；自动化浏览器不能替代这项真机验证。
