# 0.1.1包内资源验收

`node scripts/smoke-desktop.mjs --packaged`通过first/restart两阶段：隔离harness加载 `XTerminal.app/Contents/Resources/app.asar/dist/desktop/main.cjs`，实际preload、React资源、utility Host、SQLite和PTY均来自包内路径。验证键盘输入、窗口关闭保活、退出、重启与局域网设置页面。

该方式使用相同版本开发Electron和隔离数据目录，`app.isPackaged`为false，不能冒称已经验证独立安装包的所有生产分支或签名/Gatekeeper。补充 `node scripts/check-native-package.mjs` 使用应用自带Electron运行时，实际加载包内SQLite/PTY，结果见相邻desktop目录packaged-native.json。

Info.plist确认CFBundleShortVersionString/CFBundleVersion均为0.1.1。未签名、公证。测试未操作用户项目或应用数据，不调用模型。
