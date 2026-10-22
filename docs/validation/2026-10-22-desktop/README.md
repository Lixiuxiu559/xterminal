# 桌面 Shell 验证

日期：2026-10-22。macOS arm64；开发 Node 24.15.0；Electron 45.0.0 / 内置 Node 24.22.0。

## 已执行

- `pnpm typecheck`：整个应用、packages、测试与 TS smoke 脚本通过。
- `pnpm test`：82 项领域、引擎、Host、SQLite及UI传输/辅助测试通过。
- `pnpm test:storage`：现有 DDL 的 S01–S05 约束通过。
- `pnpm build`：main/preload/Host CJS 与 React 生产资源通过；终端按需加载，无 >500 KiB chunk 提示。
- `pnpm smoke:desktop`：真实 Electron utility Host + 真实 SQLite / PTY；原生目录入口通过测试专用文件夹选择夹具返回临时目录，产品代码没有绕过原生选择。
- `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm package:mac`：生成未签名的 `release/mac-arm64/XTerminal.app`。
- `node scripts/check-native-package.mjs`：安装包 Electron 的 Node 模式实际加载打包 SQLite / node-pty，执行内存数据库和受控 Shell，退出码 0。该检查不证明安装包 utility process 和 GUI 已验收。

## 直接证据

- [首次运行](first.json)：受限 preload、真实键盘、单活跃 PTY、关窗后同一 run、390 / 768 / 1440px 无横向溢出、utility 内 Ctrl+C / 中文 / 快照 / 480 KiB 输出 / 实际退出。
- [重启](restart.json)：历史项目 / 会话 / 标题仍在，旧 PTY 不会自动重启。
- [安装包原生模块](packaged-native.json)。
- [桌面实际页面](desktop-shell.png) · [窄屏实际页面](mobile-shell.png) · [连接手机设置](lan-settings.png)。窄屏截图来自桌面 renderer，不是手机已连通的证据。

## 发现与修正

- 独立 smoke 启动脚本的 appPath 与真实产品入口不同，最初未加载页面；正式资源路径改为相对构建入口解析，不依赖测试私有 Electron API。
- `window.close()` 的关闭完成是异步，测试改为等待实际窗口清空后再核对保活。
- 主动结束 Shell 的 SIGHUP 非零退出码不再持久化为失败；异常非零退出仍报告错误。
- 退出准备先冻结并排空请求；取消恢复。真实关闭开始后不把本地等待超时当作取消关闭。
- 结束记录写失败保留待落盘终态，停止接受新任务，重试清理不能假装成功。
- 合成键盘夹具最初期待大写，却未按 Shift；原始事件和 PTY 输出证明实际输入为小写，已修正夹具并重测。产品未因此修改按键映射。

本桌面smoke不调用模型或读取认证文件。独立引擎短请求及TLS/WSS测试见相邻验证目录；手机真机、长期压力、任意TUI、完整安装包独立启动、签名和公证仍未验收；Host崩溃恢复见相邻crash记录。
