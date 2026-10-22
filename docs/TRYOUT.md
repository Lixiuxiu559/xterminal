# XTerminal 0.1.1 试用

本地应用：`release/mac-arm64/XTerminal.app`。macOS Apple Silicon，当前未签名/公证。

本次试用归档：`release/XTerminal-0.1.1-mac-arm64.zip`；SHA-256 文件为同名 `.zip.sha256`，验证摘要为 `release/XTerminal-0.1.1-validation.json`。这些是本地构建产物，不随源码提交。干净检出后需要按 README 的安装、原生模块重建与打包步骤生成应用；`pnpm package:mac` 生成 `.app` 目录，不自动生成 ZIP。

1. 打开应用，点“新建会话”，通过系统窗口选择一个本地项目目录。
2. 创建时选择Claude Code、Codex或Shell；引擎创建后固定。
3. Agent依赖本机已安装并登录的官方CLI。本次验证Claude Code 2.1.304、Codex 0.157.0；Codex可在输入框旁选择已有权限的模型。
4. Shell点“启动Shell”。Agent在输入框发送任务；工具许可只对当前请求处理一次。
5. 关闭窗口会保留电脑任务；从托盘/菜单可回到工作空间。明确退出应用会停止任务。
6. 如果Host异常退出，页面会离线禁写；退出并重新打开后查看中断历史，再明确发送新任务。未确认命令不会自动重发。

手机连接仍需同一内网、开启“连接手机”、安装并信任电脑导出的公有CA证书、输入配对码并在电脑批准。真机证书/软键盘/后台恢复尚未完成验收，不将桌面窄屏测试当作手机真机通过。

本轮通过82项功能测试、15项LAN测试、Agent桌面四阶段协议E2E、两引擎6轮真实对话/工具/重启续聊、Host和应用强杀回收及早停竞态测试。详细证据见 `docs/validation/`。
