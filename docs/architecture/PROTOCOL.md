# 客户端与会话服务协议

版本：1。TypeScript 初始契约见 [packages/protocol](../../packages/protocol/src/index.ts)。本文约定产品协议，不直接暴露 Claude 或 Codex 的原生方法。

## 1. 传输与身份

- 桌面：可信 preload → 主进程 → Host，领域请求与事件通过白名单 IPC / MessagePort。
- 手机：同源HTTP/HTTPS REST获取快照，对应WS/WSS发送命令、接收回执和流式事件。模式由电脑明确选择，HTTP仅在接受明文风险的可信局域网使用；HTTPS失败不自动降级。
- `lan.enable` 接收 `{ address, mode?: 'http' | 'https' }`，省略mode沿用HTTPS；新UI默认选择HTTP但共享默认关闭。`LanState.mode`为当前模式，关闭时null。活动模式不能热切换，先关闭、撤销授权和连接，再重新开启配对。
- HTTPS Cookie保持__Host前缀与Secure；HTTP使用独立非前缀名称且去掉Secure，两者保留HttpOnly、SameSite=Strict、Path=/与host-only作用域。来源、Host、CSRF、设备权限及控制租约要求不因HTTP而变化。
- 每个连接在 Host 绑定 authenticated principal、deviceId 和 connectionId。客户端提交的 actorId 不作为身份来源。
- 每次 Host 启动生成 hostInstanceId；旧连接、控制权和 PTY epoch 均不能跨实例复用。
- `protocolVersion` 必须匹配；不兼容返回 UPGRADE_REQUIRED，不猜测字段。

## 2. 资源与接口

| 接口 | 用途 | 限制 |
| --- | --- | --- |
| GET /healthz | 运行与协议版本，不返回路径和会话 | 无敏感内容 |
| GET / | 手机静态页面与配对入口 | 不包含用户数据 |
| POST /api/v1/pairing/requests | 提交一次性配对码 | 限速、同源、有效期 |
| GET /api/v1/pairing/requests/:ticket | 等待桌面确认并领取 Cookie | 随机不可猜 ticket，短期有效，仅原申请方 |
| GET /api/v1/bootstrap | 项目、会话摘要、能力、连接身份 | 必须已授权 |
| GET /api/v1/sessions/:id/snapshot | 消息投影、状态、待处理项、lastSeq | 校验项目范围 |
| GET /api/v1/sessions/:id/events?afterSeq=N | 分页补齐领域事件 | seq 有范围与分页上限 |
| GET /api/v1/sessions/:id/terminal-snapshot | 终端 epoch、尺寸、解析 watermark | 仅 Shell，有限大小 |
| WS/WSS /api/v1/stream | 命令、订阅、事件与终端帧 | Cookie、Origin、Host 和大小校验 |

桌面独享命令：project.add、project.selectDirectory、device.approve、device.revoke、lan.enable、lan.disable、certificate.manage。手机请求这些命令一律 FORBIDDEN，不能靠隐藏按钮充当权限控制。

## 3. 可靠命令

示意：

```json
{
  "protocolVersion": 1,
  "commandId": "uuid",
  "sessionId": "session-uuid",
  "expectedRevision": 12,
  "control": {"hostInstanceId":"host-uuid","generation":4},
  "type": "agent.turn.start",
  "payload": {"text":"实现这个功能"}
}
```

创建、重命名等元数据操作有各自权限；发送、停止、授权回答需要有效控制权。Host 补充真实身份并在 SessionActor 中重新验证，不能只在网关校验一次。

| 命令 | 关键字段 | 行为 |
| --- | --- | --- |
| session.create | projectId、engine、title | engine 只在此设置；目录来自已批准项目 |
| session.rename | title | 版本冲突返回当前 revision |
| agent.turn.start | text | 空消息拒绝；同会话运行中拒绝，不自动排第二轮 |
| agent.turn.stop | runId | 只作用于匹配的运行实例 |
| interaction.respond | interactionId、response | 请求必须仍 pending 且绑定当前 run |
| control.acquire | sessionId | 用户明确接管，generation 增加 |
| control.release | generation | 释放自己的控制权，不取消任务 |
| shell.start | sessionId | 已退出的 Shell 显式创建新运行实例 |
| shell.terminate | runId | 明确结束当前 Shell，与 Ctrl+C 分离 |

回执包含 commandId、accepted/duplicate/rejected、结果或错误码。accepted 只意味着产品已接受请求，不表示模型任务或命令完成。

同一个 principal + session + commandId 重试时比较 payload hash：相同返回原回执，不同返回 COMMAND_ID_REUSED。恢复后的 outcome_unknown 必须由客户端明确处理，不自动生成新 commandId 重发。

## 4. 领域事件

```json
{
  "protocolVersion":1,
  "eventId":"uuid",
  "sessionId":"session-uuid",
  "seq":148,
  "revision":13,
  "occurredAt":"2026-10-22T03:00:00.000Z",
  "type":"message.delta",
  "runId":"run-uuid",
  "payload":{"messageId":"message-uuid","text":"接下来"}
}
```

事件类别：session.created、session.renamed、run.started、run.state.changed、message.delta、message.completed、tool.updated、interaction.requested、interaction.resolved、run.completed、run.interrupted、run.failed、control.changed、engine.capabilities.changed。

- seq 只在一个会话内部递增；不同会话的 seq 不能比较。
- revision 表示领域状态版本，不等于 seq；流式文字可以只增加 seq。
- 最终 message.completed 按稳定 messageId 替换该消息的临时流式投影，不能再附加一份全文。
- 原生状态没有映射时保留 namespaced 扩展；未知工具交互默认待处理或拒绝，不自动 allow。
- 全局项目/会话列表用独立 catalogRevision；重连时重新 bootstrap，不复用某个会话的 seq 当全局游标。

## 5. 快照与订阅的竞态处理

同一个 SessionActor 内建立订阅屏障：

1. 取得投影与 lastSeq=S，并登记订阅，从 S+1 开始缓冲后续事件。
2. 返回快照；订阅端确认 watermark 后发送缓冲事件。
3. 客户端忽略 seq<=S 及已处理 eventId；发现 seq 缺口先补齐，不越过缺口做破坏性投影。
4. 断线重连重新认证，提交最后已应用序号；如果版本、窗口或保留范围不适合，服务端要求全量快照。

分页补历史期间的实时消息也必须按 seq 合并。上层不能用“先 GET，再随便打开 WS”造成中间事件丢失。

## 6. Shell 帧

Shell 数据单独走终端通道，不把每次按键写入通用命令表或把输出当 Agent 消息。

```json
{
  "protocolVersion":1,
  "type":"terminal.input",
  "sessionId":"session-uuid",
  "runId":"run-uuid",
  "terminalEpoch":"epoch-uuid",
  "inputId":"uuid",
  "control":{"hostInstanceId":"host-uuid","generation":4},
  "data":"pwd\r"
}
```

- terminal.output 带 runId、terminalEpoch、outputSeq 与原始控制序列数据。
- terminal.resize 仅控制端可发，附 cols、rows；服务端限制有效范围。
- outputSeq 只用于终端流，不与领域事件 seq 混用。
- Host 以 xterm 解析完成回调维护快照 watermark，不能用“已接收到输出”冒充“已解析到快照”。
- inputId 在当前 epoch 内做有界内存去重，收到确认意味着 Host 已写入 PTY，不表示命令执行成功。
- 连接中断后，不自动重发未确认 terminal.input。Shell 不支持通用任务级 exactly-once，UI 需要提示输入结果不确定。
- 改尺寸或重新启动 PTY 时按协议屏障更新 epoch/尺寸，过期控制帧拒绝。

初始上限：单命令 64KiB，单次 Shell 输入 16KiB，单 WS 消息 1MiB；超过上限返回明确错误。输出按 16–32KiB 分块，观察端缓冲达到 1MiB 时要求重同步；阈值通过压测调整。

## 7. 授权与特殊交互

交互请求包含 application interactionId、runId、engine namespace、native request ID、kind 和可选回答结构。

kind 包含 permission、question、plan、elicitation、unsupported。回答由适配器验证与转换，不让客户端直接构造任意原生 RPC 帧。

提交过程：校验身份与控制权 → 核对 runId/revision → CAS pending 为 resolving → 调用适配器 → 写 resolved；同一请求只有一次有效原生回答。进程中断、请求撤销时改 cancelled，旧卡片回答返回 INTERACTION_EXPIRED。

若引擎可能已收到回答但 Host 未记录结果，标记 outcome_unknown 并查询原生结果，不能反复发送相同授权。

Codex 中“拒绝此操作”和“取消本轮”不是同一决定；Claude 的提问回答也不等于普通 yes/no。页面根据 capabilities 展示可用决定。

## 8. 错误码

| 类别 | 错误码示例 |
| --- | --- |
| 身份与设备 | UNAUTHENTICATED、FORBIDDEN、DEVICE_REVOKED、PAIRING_EXPIRED、RATE_LIMITED |
| 版本 | UPGRADE_REQUIRED、REVISION_CONFLICT、ENGINE_VERSION_UNSUPPORTED |
| 并发 | CONTROL_REQUIRED、STALE_CONTROL、SESSION_BUSY、PROJECT_BUSY |
| 会话 | SESSION_NOT_FOUND、ENGINE_UNAVAILABLE、RUN_MISMATCH、INVALID_TRANSITION |
| 交互 | INTERACTION_EXPIRED、INTERACTION_ALREADY_RESOLVED、UNSUPPORTED_INTERACTION |
| 恢复 | RESYNC_REQUIRED、TERMINAL_EPOCH_MISMATCH、COMMAND_OUTCOME_UNKNOWN |
| 资源 | PAYLOAD_TOO_LARGE、STORAGE_UNAVAILABLE、ENGINE_EXITED |

错误返回稳定 code、可展示 message、可选 retryable 及 currentRevision。不向手机返回本机凭据、完整环境或内部堆栈。
