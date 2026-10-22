# 引擎环境修复验收记录

基线：`bb5eca69910d9dec275160522444753480fa5cd7`。范围：Finder/Dock 精简 PATH 下 CLI 发现、Node 依赖、Host 与运行时环境统一。测试设计见 [测试用例](../../test-design/2026-10-22-engine-environment.md)。

## 修复前复现

执行 `pnpm build` 后运行 `node scripts/smoke-agent-desktop.mjs --restricted-path`。

- Electron PATH 仅 `/usr/bin:/bin:/usr/sbin:/sbin`。
- HOME 为临时目录；假 Claude/Codex 与 Node 在临时 `.nvm/versions/node/v24.0.0/bin`。
- CLI 使用 `#!/usr/bin/env node`，没有放进初始 PATH。
- 首阶段失败：`AssertionError: codex unavailable`，退出码 1。
- 不调用真实 CLI、不读取账户、不调用模型。

说明：这是实际 Electron/Host/页面链路的自动化复现，不是人工访达启动记录。

## 修复后

| 验证 | 实际结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 92 项通过，0 失败 |
| `pnpm test:lan` | 15 项通过，0 失败 |
| `pnpm test:storage` | DDL 与 S01–S05 通过 |
| `pnpm build` | 通过 |
| 受限 PATH Agent 桌面 | first / restart / crash / crash-restart 四阶段通过，CLI 使用 env-node，模型列表/回复/授权/停止/续聊通过 |
| 原有 Agent 桌面回归 | 最终核心 first / restart / crash / crash-restart 四阶段通过，见 `agent-regression/` |
| 新包 `app.asar` 同一受限环境 | 四阶段通过，见 `restricted-path-packaged/` |
| 新包自带运行时原生模块 | SQLite 与 PTY 通过，Electron 45.0.0 / Node 24.22.0 |
| 最终 Shell 桌面 | first / restart 两阶段通过，见 `desktop/` |

独立修复包：`release/engine-environment-fixed/mac-arm64/XTerminal.app`，使用 `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --config.directories.output=release/engine-environment-fixed` 生成。旧 `release/mac-arm64` 与原 ZIP 未替换，不中断用户运行中的旧 App。

包内验证由 Electron harness 加载新包 main/Host/UI，仍是自动化验证，不宣称已经人工访达双击验收或完成签名公证。所有本次 Agent 验证均使用受控夹具，未调用真实模型。

## 安全与交付边界

不修改用户 shell 文件、系统 PATH 或 launchctl；不结束当前用户 App。原有 ZIP 是旧归档，不因源码改动自动更新。真实账户/真实模型请求和人工访达验收不由夹具结果替代。
