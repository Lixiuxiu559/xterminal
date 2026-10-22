# XTerminal 0.1.1 试用

本地应用：`release/mac-arm64/XTerminal.app`。macOS Apple Silicon，当前未签名/公证。

本次试用归档：`release/XTerminal-0.1.1-mac-arm64.zip`；SHA-256 文件为同名 `.zip.sha256`，验证摘要为 `release/XTerminal-0.1.1-validation.json`。这些是本地构建产物，不随源码提交。干净检出后需要按 README 的安装、原生模块重建与打包步骤生成应用；`pnpm package:mac` 生成 `.app` 目录，不自动生成 ZIP。

1. 打开应用，点“新建会话”，通过系统窗口选择一个本地项目目录。
2. 创建时选择Claude Code、Codex或Shell；引擎创建后固定。
3. Agent依赖本机已安装并登录的官方CLI。本次验证Claude Code 2.1.304、Codex 0.157.0；Codex可在输入框旁选择已有权限的模型。
4. Shell点“启动Shell”。Agent在输入框发送任务；工具许可只对当前请求处理一次。
5. 关闭窗口会保留电脑任务；从托盘/菜单可回到工作空间。明确退出应用会停止任务。
6. 如果Host异常退出，页面会离线禁写；退出并重新打开后查看中断历史，再明确发送新任务。未确认命令不会自动重发。

最新HTTP简便模式包：`release/http-lan-fixed/mac-arm64/XTerminal.app`，同时包含引擎PATH修复。先从菜单明确退出旧App，再从访达打开该包；HTTP模式无需证书。主工作区97项功能/18项LAN及真实私网HTTP浏览器验证通过，包内桌面两阶段通过，见 [HTTP验收](validation/2026-10-22-http-lan/README.md)。原ZIP和下面的环境修复包仍是历史产物，不包含最新HTTP功能。

本次环境修复的新包在 `release/engine-environment-fixed/mac-arm64/XTerminal.app`，与旧包并存。先通过 XTerminal 菜单明确退出旧应用，再从访达打开新包（仅关闭窗口不会退出）；任务仍在运行时请先决定是否结束。新包的包内受限环境四阶段已通过，人工访达启动与真实账户会话仍需试用确认。验证说明见 [引擎环境验收](validation/2026-10-22-engine-environment/README.md)。

源码中的引擎环境修复会在启动时自动恢复 PATH 并定位 nvm 等安装目录；先前归档的 ZIP 不会随源码更新，需要重新打包后使用。安装/升级 CLI 后，应从菜单明确退出再重开，而不是只关闭窗口。如果仍不可用，请查看引擎按钮下的版本、登录或路径错误；无需修改系统 PATH。

手机连接：电脑与手机在同一可信内网，打开“连接手机”选择私网IP，默认HTTP简便模式无需证书，开启后手机直接打开显示的http地址，输入配对码并在电脑批准。连接未加密，仅用于可信家庭网络/个人热点，不用于公共Wi-Fi。HTTPS为可选加密模式，仍需安装并信任公有CA证书；证书失败不会自动降级。切换模式先关闭共享再开启、重新配对，本地任务不停止。真机证书/软键盘/后台恢复尚未完成验收，不将桌面窄屏测试当作手机真机通过。

本轮通过82项功能测试、15项LAN测试、Agent桌面四阶段协议E2E、两引擎6轮真实对话/工具/重启续聊、Host和应用强杀回收及早停竞态测试。详细证据见 `docs/validation/`。
