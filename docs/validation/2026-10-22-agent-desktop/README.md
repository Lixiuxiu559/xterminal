# Agent桌面端到端验收

版本：0.1.1，macOS arm64。复用真实Electron窗口、原生输入、生产React/preload/utility Host/SQLite及CLI适配器；仅本地目录选择弹窗由独立harness返回临时项目。

## 协议夹具层

命令：`pnpm smoke:agent-desktop`，不调用模型。四阶段first、restart、crash、crash-restart均通过。

两个引擎各覆盖真实弹窗选择、中文emoji消息、delta最终覆写、权限允许本次/拒绝、问题完整性/选项/自由答案、停止等待终态、草稿切换保留。活跃Claude轮次关窗后恢复同一run。重启不自动发任务，明确续聊使用原native context。

生产Host故障注入验证页面离线禁写、无自动重启、退出后再启动的中断历史与续聊。最新助手消息的数据和DOM全文均绑定本轮，不能由历史标记误满足断言。

报告：[first](fixture/first.json)、[restart](fixture/restart.json)、[crash](fixture/crash.json)、[crash-restart](fixture/crash-restart.json)。[协议元数据](fixture/protocol-metadata.json)仅测试输入/原生ID/decision/answers/pid/cwd，不含认证信息。

## 真实模型层

命令：`pnpm smoke:agent-desktop --real --model gpt-6-astra --tools`。此命令会使用已有官方登录与模型额度，默认测试不会调用它。

Claude Code 2.1.304与Codex 0.157.0各完成：短标记对话、一次指定临时文件写入工具任务、重启后只据上下文恢复随机标记，共6轮。核验助手最新回复、真实文件内容、工具完成记录、重启前后同一原生context、最终无活跃run、六条回执完成。没有改变官方CLI全局模型/提供方/认证配置。

工具批准仅由harness匹配测试指定完整printf命令后点击“允许本次”；其他请求直接让测试失败，不自动批准未知操作。提问与停止的所有原生分支在夹具层验证，不冒称本轮真实模型每一分支都出现。

报告：[first](real/first.json)、[restart](real/restart.json)。截图：[Codex](real/codex-tool.png)、[Claude](real/claude-tool.png)。这不是完整安装包GUI或手机真机验收的替代。
