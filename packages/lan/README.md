# LAN 安全网关基础

`new LanGateway(options)` 默认不监听。仅本地代码可调用 `start()`、`rotatePairingCode()`、`approvePairing(ticket)`、`rejectPairing(ticket)`、`revokeDevice(id)` 和 `stop()`；这些操作不在手机 RPC 白名单中。

`start()` 返回实际 HTTPS 地址、仅本次返回的 8 位配对码、CA 公钥证书导出路径。服务只保存配对码的带盐哈希，120 秒后失效；成功提交一次申请立即作废，桌面可调用 `rotatePairingCode()` 展示下一码。CA 私钥和 IP SAN 服务证书留在 `dataPath/certificates`，目录 0700、文件 0600。手机必须由用户完成本地 CA 信任，服务不降级 HTTP、不绕过验证。

手机接口：

| 接口 | 行为 |
| --- | --- |
| `GET /`、静态资源、`GET /healthz` | 不需要设备授权，不包含会话数据 |
| `POST /api/v1/pairing/requests` | `{code, deviceName}`；返回 `ticket`，设置申请方 secret Cookie |
| `GET /api/v1/pairing/requests/:ticket` | 原申请方轮询状态；本地批准后单次领取设备 Cookie |
| `GET /api/v1/bootstrap` | 设备 Cookie 认证后调用注入的 `bootstrap(principalId)` |
| `WSS /api/v1/stream` | 接收产品 `{id, method, params}` RPC，返回 `RpcResponse` 并广播 `AppEvent` |

手机身份固定为 `device:<deviceId>`，从已验证 Cookie 得出，不信任客户端的身份字段。仅保留可选顶层 `control` 原样交给 Host 验证租约 stamp，丢弃 `principalId` / `actorId`。`catalog.changed` 按每个连接覆写正确设备身份；本机配置事件 `lan.changed` 不广播到手机。Host 仍须在注入的 `execute` 内按该身份验证会话、项目范围与控制租约。网关仅允许当前产品的会话、Agent、Shell 与控制权方法，未知方法和桌面专属方法拒绝；不转发原生引擎 RPC。

鉴权失败返回稳定 `UNAUTHENTICATED` / `DEVICE_REVOKED`。WSS 升级拒绝带同样 JSON 错误和 `X-XTerminal-Error`；浏览器原生 WebSocket 无法读取非 101 的正文，客户端应在连接错误后用同源 bootstrap 请求分类，提示重新配对。已连接设备失效时使用关闭原因 `DEVICE_REVOKED`。

POST/WS 必须有精确自身 Origin；GET 允许缺少 Origin，但拒绝不匹配 Origin、cross-site/same-site Fetch Metadata 和不匹配 Host。所有 Cookie 使用 Secure、HttpOnly、SameSite=Strict。设备授权 7 天有效，磁盘只保存 token hash；关闭访问会撤销已有授权，重新开启不复活旧 Cookie。撤销或过期通过 `onDeviceRevoked(principalId)` 通知 Host 释放控制租约。

默认仓储是原子写入、仅哈希的 `devices.json`；可通过 `DeviceRepository` 注入 Host 的单写者 SQLite 仓储。`listDevices()` 不返回哈希，默认未监听时也可列举或撤销设备。

限制：HTTP/WS 命令 64 KiB，WS 帧 1 MiB；单连接入队 32 条/1 MiB，输出缓冲 1 MiB 后关闭并要求重同步；请求排队后执行前再次验证设备。快照与事件的领域水位屏障、重连补齐仍由 Host 提供，本模块不宣称单独完成这条集成路径。

验证：`node --test packages/lan/src/*.test.ts`。网络测试仅通过构造器第二参数 `LanTestDependencies.allowLoopback` 在 127.0.0.1 临时端口启动真实 TLS/WSS，生产 options 不接受 loopback。沙盒禁止 listen 时需由上层运行获准的本机测试；这不代表手机 HTTPS 信任或真机集成已经验收。
