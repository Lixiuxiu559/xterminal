# 系统架构设计

版本：v1.1（对应应用 0.1.1）\
日期：2026-10-22\
状态：三引擎桌面、局域网集成及本轮崩溃恢复已验收；手机真机与独立安装验收待完成\
范围：macOS 首发，本地执行，手机内网直连

相关文档：[产品需求](PRD.md) · [设计规范](DESIGN.md) · [通信协议](architecture/PROTOCOL.md) · [实施计划](IMPLEMENTATION.md) · [交互架构图](architecture/system.html)

## 1. 核心决策

**一个本地会话服务，两个界面入口，三种固定引擎。**

桌面和手机共享页面组件与会话模型。会话服务持有引擎进程、任务状态、待授权请求与历史记录，界面的生命周期不决定任务的生命周期。

- 桌面应用：Electron，负责窗口、菜单、托盘、目录选择、后台服务管理。
- 前端：React + TypeScript + Vite，共用设计系统，按容器宽度适配。
- 会话服务：运行在 Electron utility process 的 Node.js / TypeScript 服务。
- Claude Code：官方未修改 CLI 的 stream-json 持续输入与 stdio 控制通道；当前锁定 CLI 2.1.304。
- Codex：官方 `app-server` 的 stdio 双向协议。
- Shell：`node-pty` 托管真实交互式 Shell，前端使用 xterm.js。
- 持久化：SQLite，服务端单写者；PTY 输出默认仅保留有限内存缓冲。
- 手机：电脑提供 HTTPS 页面和 WSS，不设置产品云端或中继。

这是架构决策，不是已完成的运行实现。具体依赖版本通过 M0 打包与接入验证后固定到 lockfile，不凭最新在线文档假定本机协议完全一致。

### 1.1 直连与本地执行的含义

手机通过电脑的内网地址直接访问该电脑提供的页面和会话服务；无需发现服务器、信令服务器或 WebRTC。这里的“点对点”是产品连接边界，采用普通 HTTPS/WSS 客户端与服务器通信即可。

所有 Shell 和 Agent 工具在电脑上执行，产品不提供云端计算。Claude Code、Codex 仍会按用户的官方配置连接模型服务；“本地执行”不代表模型推理离线。电脑休眠、关机或离开同一可达内网时，手机不能继续访问；本产品不唤醒电脑，也不代为延续执行。

### 1.2 实现必须保持的约束

1. 会话只在创建时选择引擎，领域类型和数据库共同禁止修改。
2. Host 是会话状态和进程的唯一所有者；桌面窗口、手机页面只负责展示与操作。
3. 手机不能新增任意项目路径、修改引擎可执行文件或批准其他设备。
4. 控制权更换不重新执行任务；断线重连不自动重发 Shell 输入或结果不确定的 Agent 请求。
5. 运行状态来自实际进程及引擎协议；模拟原型、命令 accepted 和流式正文都不能充当任务完成依据。

## 2. 默认产品约定

下列事项是为开工收敛的第一版默认值，与原先已确认约束分开记录。

| 事项 | 第一版约定 |
| --- | --- |
| 桌面系统 | macOS 优先；模块与协议保留跨平台能力，不承诺首版支持其他系统 |
| 关闭窗口 | 隐藏 / 关闭 UI，主进程与会话服务继续运行，托盘可重新打开 |
| 显式退出 | 菜单退出结束服务；有活动任务时展示具体任务清单，确认后结束 |
| 引擎安装登录 | 用户先在本机安装和通过官方流程配置；应用检测可用性，不代收登录凭据 |
| 手机新建 | 可在已授权项目内创建会话；新增项目、任意目录选择只允许桌面 |
| 多端控制 | 可同时查看；每个会话只有一个控制端，其他端需明确接管 |
| 同项目并发 | 同一规范化项目目录同时只执行一个 Agent 轮次；Shell 开发服务可并存 |
| 会话整理 | 搜索、重命名纳入首版；归档与删除延期 |
| 文件改动 | 保留引擎原生改动事件扩展位，首版不做独立文件编辑器和 diff 工作台 |
| Shell 选择 | 默认用户登录 Shell；仅接受桌面确认的可执行文件配置，手机不指定任意程序 |
| 后台独立性 | 独立于窗口，不独立于整个应用；不注册系统常驻 daemon、不自动开机启动 |
| 进程恢复 | 恢复已保存对话上下文；不承诺恢复已结束的命令、PTY 或原来的 PID |

## 3. 为什么选择这套技术

| 选择 | 原因与代价 |
| --- | --- |
| Electron | 与 Node 引擎集成及 PTY 生态衔接直接，桌面 Chromium 渲染一致；代价是包体和常驻内存较高 |
| 暂不选 Tauri | 可以做，但当前要整合 Node 侧引擎和原生 PTY，会额外引入 Rust / Node sidecar 分发与桥接，第一版收益不足 |
| React + TypeScript | 桌面和手机共享组件、领域模型与类型；原型的设计变量可以迁移，演示脚本不带入正式运行层 |
| SQLite | 单用户、单机、单服务持有状态，不需要 Redis、远程数据库或消息中间件 |
| 版本化事件流 | 支持多个观察端、断线补齐和问题定位；不是把前端内存当作数据源 |
| 三个适配器 | 共用任务与消息基础能力，同时保留引擎各自的权限和特殊交互 |

SQLite 驱动默认选成熟的 `better-sqlite3`；它和 `node-pty` 均按选定 Electron ABI 构建。`node:sqlite` 在不同 Node 版本仍存在稳定性差异，本期不以开发机能 import 为分发保证。M0 必须在打包后的 utility process 中真实加载两个原生模块。

事实依据见 [接入调研](research/2026-10-22-engine-integration.md)。Electron 的独立进程与 ABI 要求依据 [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。

## 4. 进程与模块边界

架构图箭头表示主要调用方向，回复与事件沿相同通道返回。Agent 同样通过官方工具读写本机项目目录，图中未重复绘制所有文件访问边。图示是计划架构，不表示所有模块已经实现。

### 4.1 桌面主进程

只负责操作系统能力和监督会话服务：

- 单实例锁、窗口、菜单、托盘、生命周期。
- 原生目录选择、引擎可执行路径选择与版本检查。
- 启动 utility process，以 MessagePort 传递已校验命令与订阅。
- 设备配对批准、撤销、内网监听开关与证书管理。
- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- preload 只暴露领域白名单，不暴露原始 `ipcRenderer`、`fs`、`exec`。

生产桌面页从打包资源的自定义 `app://` 协议加载。IPC 同时校验 sender、frame 和 payload；开发 Vite 地址单独白名单。外部链接只允许确认过的 http/https 交由系统浏览器打开。

### 4.2 会话服务 Session Host

唯一的产品状态权威，内部模块包括：

| 模块 | 职责 |
| --- | --- |
| ProjectService | 已批准的规范化项目目录与项目级 Agent 锁 |
| SessionRegistry | 产品会话 ID、固定引擎、原生上下文 ID 的映射 |
| SessionActor | 每个会话串行处理命令、引擎回调、停止及授权回答 |
| EngineSupervisor | 生命周期、退出检测、信号与超时，避免把运行失败伪装为完成 |
| ApprovalBroker | 挂起引擎请求、用户回答、过期和撤销，保证一次有效回答 |
| EventJournal | 持久化领域事件、维护顺序号和前端投影 |
| ControlLease | 多端只读与单端控制，防止键盘输入和终端尺寸互相抢占 |
| TerminalHub | PTY 流、规范终端尺寸、解析状态、快照与流控 |
| DeviceAccess / LanGateway | HTTPS/WSS、配对、设备授权、Origin/Host 检查与撤销 |
| Repository | SQLite 事务、迁移及本地数据访问 |

图中的 Gateway 是 Host 内部模块，不要求额外 OS 服务。SQLite 只有 Host 写，前端不直接打开数据库。

### 4.3 引擎进程

- 每个活跃 Claude 会话由 CLI transport 持有官方 CLI 子进程。
- 每个活跃 Codex 会话先采用一个 app-server 子进程，绑定一个 thread；暂不做跨会话进程池。
- 每个 Shell 会话持有一个 PTY 与其子进程。
- 适配器代码异常按会话捕获；原生模块崩溃仍可能影响整个 Host，第一版如实接受此故障域，后续按实际需要拆工作进程。
- 已保存但未打开的 Agent 会话不常驻一个引擎进程；恢复时按原生 ID 明确加载。

不把进程隔离称作文件系统沙箱。同一系统用户启动的会话仍可能访问同一磁盘与凭据资源。

## 5. 前端结构

共用 AppShell、ProjectNavigation、SessionHeader、EngineBadge、DeviceConnection、SessionDetails。

- AgentSessionView：消息块、工具摘要、任务状态、授权与提问。
- ClaudeSessionView：在共用视图上适配 Claude 权限、计划及提问能力。
- CodexSessionView：适配 Codex item/turn、审批和请求输入。
- ShellSessionView：xterm.js 实例及触屏控制键。
- DesktopTransport：通过 preload 的领域 IPC 接口发送命令、订阅事件。
- BrowserTransport：同源 HTTP 快照 + WSS 命令与事件。

组件依赖 `SessionClient`，不引用 Electron、CLI SDK 或 node-pty。引擎名称不可编辑；引擎配置通过 capabilities 决定是否显示。未知特殊能力显示“当前版本尚不支持”，不能默默放行。

Agent 数据为服务端事件投影；连接状态、未发送草稿、滚动位置是界面状态。普通浏览器不持有引擎 API key 或 OAuth token。

## 6. 三种引擎适配

### 6.1 共用边界

适配器输出统一的最小语义：开始、消息增量、消息完成、工具事件、用户交互、轮次结束、运行错误；必要时附带引擎命名空间下的版本化扩展。

不能用统一的 `send(string)` 假装三种引擎相同。Agent 使用轮次命令；Shell 使用原始终端输入、尺寸和进程状态。

同一会话的 engine 在领域层只读，数据库也禁止更新。引擎不可用时保留会话和错误，不切换另一引擎。

### 6.1.1 当前崩溃回收实现（0.1.1）

Host为每个生产引擎建立独立短生命周期监护。Agent使用独立进程组，监护持有stdin写FD；Shell监护持有PTY master FD。Host生命管道断开后，先核验目标出生身份和进程组，再清理可核验的子树/组，TERM后升级KILL。监护就绪前不派发用户任务；初始化失败等待已启动进程真实退出后报告失败。实现依赖固定Node/Electron及node-pty版本，不能将该机制视为跨平台通用保证。

监护不扫描历史PID文件、不按进程名杀进程；引擎自主先退出后留下的独立工具、工具主动daemonize/setsid、机器断电为未覆盖边界。历史增量按50ms合并，恢复以SQLite提交边界为准，不承诺保留仍在内存中的最后字符。具体实证和限制见 `docs/validation/2026-10-22-crash/README.md`。

### 6.2 Claude Code

Host 在启动时恢复引擎环境：显式路径覆盖 → 当前 PATH → 有界登录 Shell PATH → 常见安装目录。每个引擎保存独立的绝对路径与环境快照，检测、模型枚举和实际运行共用；为 env-node CLI 补齐 Node 运行目录，不全局修改 `process.env` 或系统 PATH。登录 Shell 固定在用户 HOME 执行、有超时和输出上限，只提取 PATH，原始输出和环境不进入页面或 LAN catalog。CLI 安装或 Shell 环境改变后需明确重启 Host，现有会话不自动替换运行版本。

生产使用用户已安装、未修改的官方 CLI，通过 `--input-format stream-json --output-format stream-json` 持续输入。stdio 权限与控制握手依据已发布 SDK 0.3.304 的协议实现，当前严格锁定 CLI 2.1.304；SDK 仅作 TypeScript 类型引用，不在生产调用 `query()`。版本变化必须先验证协议。

- 使用明确的 `resume` ID，禁止按目录自动选择“最近一个”会话。
- 保留原生 session、tool、请求和 run ID，权限与提问只接受当前轮次的一次回答。
- 保持官方默认提示词与用户已有配置；不设置 API/provider、SDK 认证或计费环境变量。
- 检测仅读取官方 `auth status --json` 的登录可用状态，不将账户对象、凭据或环境发给页面。
- 使用 manual 权限模式；未知控制请求明确拒绝，无法确认停止时等待实际子进程结束。
- 本机已有官方登录的真实短请求已通过，不代表任意账户、版本和发行方式已完成认证验收。

实现与验证记录：`packages/engines/claude/src/cli-query.ts`、`runtime.ts` 及 `docs/validation/2026-10-22-agent/claude-turn.json`。此选择替代最初的 SDK query 方案，领域协议与 UI 保持一致。

### 6.3 Codex

使用 `codex app-server --listen stdio://`，不把原生 app-server WebSocket 暴露到内网。

流程：initialize → initialized → 检查账户/能力 → thread/start 或 thread/resume → turn/start → 接收 item 与 turn 事件。

- 绑定产品 session ID 与 `thread.id`，不能用其他 session 字段混替。
- 每条消息通知按 threadId、turnId、itemId 路由。
- `turn/interrupt` 只标记 stopping；轮次结果到达后再更新状态。
- server request 不是普通通知，保留 request ID 回答；审批、提问与 elicitation 分别适配。
- 首版显式用户审批，不启用自动审查代理；不设 danger-full-access 为默认。
- 使用本机固定 CLI 生成的 schema；在线示例与本机枚举不一致时，以已验证版本契约为准。

接口依据 [OpenAI Docs: Codex App Server](https://learn.chatgpt.com/docs/app-server)。认证与商业发布前适用条件要单独复核，应用不自行读取或转发用户 token。

### 6.4 Shell

`node-pty` 托管交互进程，xterm.js 渲染终端控制序列，不用 textarea + 日志列表替代真实终端。

- Shell 从已确认目录启动，保留 cwd 与环境进程上下文。
- 状态只保证 Shell 进程存活、已退出或异常，不通过输出花样猜测任意命令“完成”。
- Ctrl+C 是终端输入控制字符，交给前台进程组；“结束 Shell”是独立操作。
- 默认不持久化用户按键或 PTY 输出到磁盘，避免把密码输入写入应用日志。
- OSC 52 剪贴板等敏感终端扩展默认不启用；外部超链接需用户操作。

## 7. 多端控制与并发

### 7.1 单会话控制权

所有已授权端可以查看；只有控制端可以发送消息、回答授权、停止任务、输入 Shell 或调整终端尺寸。

- 创建会话的端获得控制权。
- 其他端明确点击“接管操作”，Host 串行授予新的 lease generation，并广播变更。
- 心跳建议 5 秒、租期 15 秒；失联释放控制权，不结束任务。
- 旧端后到的命令携带过期 lease generation，会被拒绝。
- 已受理并开始执行的轮次不因控制权切换重启或回滚。
- 重新连接不自动抢占另一端；同一时刻只接受一个有效控制者。

### 7.2 项目与文件并发

同一 realpath 项目目录的 Agent 轮次共用一把应用内写锁。等待授权仍属于同一个轮次并继续持锁；其他 Agent 会话返回 PROJECT_BUSY，用户可停止原轮次或稍后再试。

Shell 可以运行开发服务，与 Agent 共用文件是用户的显式行为。该锁不阻止其他编辑器、其他终端或父子目录之外的文件操作；不把 cwd 当作安全沙箱。未来如需同目录多个 Agent 同时改代码，先引入明确的 worktree 体验。

## 8. 事件、持久化与重连

### 8.1 数据权威

SQLite 保存项目、会话、轮次、已完成消息投影、已脱敏的领域事件、交互请求、命令回执及设备授权。原生引擎保存自己的上下文，产品只记录其 ID 与版本，不直接修改引擎私有数据库。

每个会话事件有递增 `seq`。快照包含 `lastSeq`，订阅从该值之后补齐；客户端按 event ID / seq 去重。

事件和投影在同一事务提交，再广播。消息增量可按约 50ms 小批合并落盘，最终 item 完成事件校正投影；未提交增量不作为可靠确认。性能参数是初始配置，必须压测。

### 8.2 命令幂等与不确定结果

可靠命令带 `commandId`，同一 actor 下先检查已有回执。用户消息入库、命令 accepted 和首个领域事件原子提交，再交给适配器。

产品数据库与外部引擎之间没有分布式事务。崩溃可能发生在“引擎已收到、产品未写回 receipt”之间，因此不承诺全链路 exactly-once。恢复后查询引擎状态；无法确认时标记 outcome_unknown，不自动重跑用户消息或命令。

Shell 输入不是可重放任务：连接断开后清除未确认发送队列，保留尚未发送草稿，不能自动重发 Enter 或整条命令。

### 8.3 终端重新接入

Host 维护规范终端尺寸与有限 scrollback 的服务端终端状态；候选为 `@xterm/headless` + `@xterm/addon-serialize`，需 M0 验证快照覆盖范围。

1. 把收到的 PTY 流按顺序送入服务端终端解析器。
2. 以解析完成的 outputSeq 建立快照屏障，返回 terminalEpoch、尺寸、快照内容与 watermark。
3. 客户端恢复快照后接收 outputSeq 大于 watermark 的数据，不能重放快照已包含的输出。
4. 只允许控制端调整尺寸，其他端按规范尺寸显示或在终端内部滚动，不能互相触发 resize。

首次默认最多保留 5000 行 scrollback；渲染慢的观察端达到缓冲上限后要求重新快照，不让一个手机拖停全部客户端。服务端解析器本身落后时通过 PTY pause/resume 反压。初始阈值写入配置，压测确认中断响应和内存上限。

序列化帧缓冲不等于完整恢复任意 TUI 的全部隐藏状态。首版保证常见 Shell 与日志操作；vim 等复杂全屏程序纳入明确兼容性矩阵，未经验证不宣称全面兼容。

## 9. 内网配对与安全边界

### 9.1 访问入口

- 默认关闭 LAN listener；用户从桌面显式开启。
- 选择一个私有 IPv4 地址绑定，第一版不支持公网、UPnP、穿透或自动中继。
- 提供显式选择的 HTTP/WS 简便模式与 HTTPS/WSS 加密模式；UI默认选择HTTP但共享仍默认关闭，旧API省略mode保持HTTPS。TLS失败不自动降级。
- HTTP无需证书，仅用于用户接受明文风险的可信家庭网络/个人热点：内容、访问令牌和操作可能被同网攻击者窃听或篡改；来源校验和配对不能替代加密。
- HTTPS证书在本机生成和保存；手机首次需要完成本地证书信任，不承诺无感跳过浏览器证书校验。HTTP不生成或导出证书。
- 不引入公共证书服务或公网域名，不提供自动穿透。两种模式均须通过各自验收，不能把HTTP测试当作HTTPS证书真机验收。
- IP或模式变化先关闭旧listener、断开旧连接并撤销授权，再显式开启重配。HTTPS更新SAN，桌面IPC和本地任务不受影响。

### 9.2 配对

1. 桌面打开访问开关并生成 8 位一次性配对码，120 秒有效，仅在 Host 内存保留校验值。
2. 手机打开所选模式的地址（HTTPS先完成证书信任，HTTP无证书），再提交配对码与设备显示名。
3. Host 限速校验，生成待确认请求；桌面通过本机 IPC 明确允许或拒绝。
4. 允许后向同源手机发放随机设备会话，不放URL。HTTPS使用 `__Host-xterminal-device` / `__Host-xterminal-pairing`，含Secure、HttpOnly、SameSite=Strict、Path=/；HTTP使用独立名称 `xterminal-http-device` / `xterminal-http-pairing`，仅去掉Secure，不使用__Host前缀。不接受另一模式Cookie作为当前授权。
5. Host 仅存 token 哈希；有效期初始 7 天，设备撤销或关闭访问时实时关闭相应连接并失效授权，同时释放相应控制租约；已开始的本地任务继续运行。

设备名称是用户输入，不能作为身份凭据。默认每来源 5 次失败触发限速，并有 Host 全局失败预算；配对请求过期后不保留可领取授权。

### 9.3 权限分级

| 能力 | 桌面本机 | 已配对手机 |
| --- | --- | --- |
| 查看会话与历史 | 是 | 是 |
| 控制当前会话 | 有有效控制权 | 有有效控制权 |
| 在已批准项目创建会话 | 是 | 是 |
| 新增项目根、选择引擎可执行文件 | 是 | 否 |
| 开启 LAN、批准设备、管理证书 | 是 | 否 |
| 查看或获得引擎凭据 | 否 | 否 |

HTTP/WS 都检查允许的 Host、精确 Origin、设备授权和消息大小；不允许任意 CORS，也不因来源是内网就绕过认证。关键写操作验证 CSRF / 同源信息，WS 升级校验与后续每条命令都做权限检查。

消息 Markdown 禁止原始 HTML，工具 JSON 与路径按文本转义。生产 CSP 仅允许打包资源和指定连接，不加载运行时 CDN 或第三方脚本。

## 10. 生命周期与故障处理

| 事件 | 行为 |
| --- | --- |
| 切换会话 / 手机页面关闭 | 解除订阅，任务继续 |
| 桌面关窗 | 窗口释放或隐藏，Host 和任务继续 |
| 手机断网 | 输入失效、控制租约过期；本机任务继续 |
| 电脑休眠 | 不主动保持唤醒；恢复后重新检查引擎和网络，不能假装持续在线 |
| 引擎退出 | 活跃轮次标记中断/错误，撤销挂起交互，不显示完成 |
| Host 崩溃 | 客户端离线；核验并回收旧运行实例。无法确认退出时阻止相关会话重新执行，不自动重跑任务 |
| 应用重启 | 历史可查看；Agent 显式恢复原生上下文，Shell 需要新建运行实例 |
| 显式退出应用 | 列出活动任务，确认后停止、等待子进程退出、落盘、关闭 listener 和数据库 |
| 停止超时 | 保持 stopping 提示；强制结束运行实例需明确动作，不仅在 UI 改 idle |
| 磁盘写满 / SQLite 提交失败 | 不确认命令成功，不继续扩张内存；停止接收新任务并保留明确故障原因 |

正常结束时，监督器使用自己创建的子进程句柄，不能只按旧 PID 杀进程，避免 PID 重用误杀。Host 崩溃后的句柄丢失需要单独处理：登记运行实例及启动身份，核验旧进程是否已因管道 / PTY 关闭而退出；不能确认安全回收时保留中断状态与清理提示，不在同一项目继续自动启动任务。该路径必须在 M0 实测。开发者的 `nohup` / 主动脱离的后台进程不纳入“能完全回收”的承诺。

## 11. 数据与日志

数据库位置遵循 Electron userData，macOS 初始为用户 Application Support 下的应用目录，目录权限 0700、数据库及日志 0600。SQLite WAL 开启 foreign_keys、busy_timeout，迁移前备份，单事务迁移，失败拒绝启动写服务。

- 不记录按键、请求头 Cookie、配对码、SDK 环境变量或引擎认证文件。
- 日志记录 sessionId、runId、commandId、事件类别、耗时和错误码，不默认记录完整提示词或工具参数。
- 保留稳定错误码供 UI 解释，不把 stdout 与 stderr 混入协议帧。
- 数据库不宣称全盘加密；受系统用户权限与磁盘保护，凭据由官方引擎管理。

详见 [数据库初始 DDL](architecture/schema.sql)。

## 12. 工程目录与依赖方向

```text
apps/
  desktop/                  Electron main、preload、打包入口
  ui/                       桌面和手机共用 React 应用
packages/
  protocol/                 请求、事件、能力和错误契约
  core/                     会话状态、命令、控制权、授权和项目锁
  host/                     utility process 装配、IPC、LAN listener
  storage/                  SQLite 仓储、迁移与备份
  engines/
    claude/                 Claude SDK / CLI 兼容适配
    codex/                  app-server 传输与原生 schema
    shell/                  PTY 与终端快照
  ui/                       设计变量与基础组件
  test-support/             假引擎、可控时钟与协议夹具
prototype/                  已交付设计原型，保留作视觉参考
```

依赖单向：ui → protocol；desktop → protocol / host 入口；host → core / engines / storage；engines → protocol；core 不导入 Electron、React 或具体引擎 SDK。禁止 UI 直接 import 引擎和数据库。

首版使用 pnpm workspace，不引入微服务框架或远程任务调度器。

## 13. 开工门槛与验证顺序

架构不依赖先把所有未知都解决。M0 先验证风险最高的组合，同时领域协议与状态机可以开工。

1. 打包 Electron utility process 能加载 SQLite 与 node-pty，关闭窗口后 PTY 存活，显式退出能回收测试子进程。
2. 分别验证 Claude、Codex 的流式响应、权限、提问、停止、原生 ID 恢复；既有认证不能用时清楚说明，不自动换凭据或模型服务。
3. 终端在桌面和手机尺寸切换后输出顺序正确，重连不会重复输入或丢失快照边界。
4. iOS Safari、Android Chrome 完成本地 HTTPS 信任和配对；未经这一步不宣称手机功能完成。
5. 再移植原型 UI 并连接真实服务，按 [实施计划](IMPLEMENTATION.md) 逐条验收。

本次已核对官方文档、本机 CLI 版本和 Codex schema；未发起真实模型任务、未读取用户凭据、未安装运行时依赖。没有把调研证据写成已完成集成测试。
