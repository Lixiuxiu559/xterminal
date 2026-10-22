# 架构与基础代码验证记录

日期：2026-10-22

交付前复核：重新运行 `pnpm test` 与 `pnpm test:storage`，10 项策略测试与 S01–S05 约束检查均通过。复核仅覆盖基础契约与 DDL，不扩展为真实引擎、桌面应用或手机集成验收。

## 实际完成

| 项目 | 结果 |
| --- | --- |
| `pnpm test` | 10 项 Node test 通过，验证基础会话状态与控制租约策略 |
| `pnpm test:storage` | SQLite DDL 与 S01–S05 数据约束通过，使用内存数据库 |
| Archify validate / deliver | showcase，9 / 9 检查，0 错误、0 警告 |
| 架构图 visual-check | 1440×900、1600×1000、1920×1080、2048×1320 均无横向或纵向溢出 |
| 人工视觉检查 | 已查看 1440×900 浅色与 2048×1320 深色截图，节点、关系和说明可见，未裁切 |

第一次图形布局的视觉检查发现高度溢出；已使用新候选 `system-v2.architecture.json` 调整布局并重新生成。`system.architecture.json` 是保留的早期布局输入，不是最终输入。

最终图类型：architecture。交互 HTML：[system.html](system.html)。

最终交付回执：

```json
{
  "specification": {
    "path": "system-v2.architecture.json",
    "sha256": "e6f161293afde6c230f18acf2eb20c2675681643295345c2b244eb6b2dc34f0d",
    "bytes": 5266
  },
  "artifact": {
    "path": "system.html",
    "sha256": "6b80129a23af4bcb5c3ee22b26525cf018dc5cd598fca89042a1f18bebd4b0cd",
    "bytes": 717382
  },
  "checksPassed": 9,
  "checkCount": 9,
  "compositionErrors": 0,
  "compositionWarnings": 0
}
```

自动化截图回执仍使用工具默认的 `visualReview: pending`；上表的人工查看记录是额外的真实检查，没有修改工具回执或交付 HTML。

## 没有完成或不在本轮范围

- Node 原生 TypeScript 去类型运行测试不是完整 tsc 类型检查，目前尚未建立前端 / Electron 构建流程。
- 尚未安装 Electron、React、node-pty、SQLite 驱动及引擎 SDK 等正式运行依赖。
- 尚未发起真实模型任务、验证用户认证、启动真实 PTY 或连接手机真机。
- 协议、状态策略与 DDL 只是 M0 的一部分，不等于实际 Host 或可运行桌面应用。
- 项目没有 Git 基线，未执行 diff-review；也未配置复杂度与突变测试工具，本轮不报告其结果。
- 文档和基础代码均为本地文件，尚未提交到 Git。
