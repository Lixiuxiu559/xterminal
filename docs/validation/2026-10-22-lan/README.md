# 局域网接入验证

日期：2026-10-22，macOS arm64。命令：`pnpm test:lan`，15项通过。测试使用随机loopback端口与临时证书/数据库；生产仅允许RFC1918私有IPv4，不能启用测试loopback参数。

已验证：

- 真实HTTPS/WSS，CA信任链与IP SAN；不信任CA、错误主机名和跨Origin访问被拒绝。
- 配对码120秒、一次使用、申请方HttpOnly secret、电脑批准、单次设备Cookie领取；磁盘只保存hash。
- WSS鉴权和方法白名单；手机不能管理LAN或获得本机LAN事件，catalog身份按各设备改写。
- 七天过期、设备撤销、关闭共享、重新开启不复活旧Cookie；命令/消息/缓冲上限与猜码限流。
- 真正的Gateway→SessionHost→SQLite集成：配对后读取同一会话，接管使旧桌面stamp收到STALE_CONTROL；续租不抢占；撤销关闭手机连接并释放控制，电脑任务继续。
- 关闭前加载设备仓储；并发撤销写入未完成时关闭会等待；保存失败后重复关闭重试，不把内存撤销当成已落盘。

`host-integration.test.ts`使用真实TLS、WSS、Host、SQLite，终端进程使用可观测夹具；真实PTY由独立Electron smoke验证。该组合不等于手机已完成真实Shell操作。

桌面连接设置截图：`../2026-10-22-desktop/lan-settings.png`。手机安装与信任CA、移动Safari/Chrome、软键盘、后台切换和真实Wi-Fi变化尚未验收。未绕过证书校验，未监听公网，未调用模型。
