# HTTP 简便局域网实施与验收

## 授权与边界

用户明确接受可信局域网明文风险，并明确授权HTTP模式Cookie去掉Secure。HTTPS保留可选，配对/桌面批准/Origin/Host/CSRF/控制租约不取消。共享默认关闭，UI默认选HTTP，旧省略mode接口HTTPS兼容。

HTTP传输内容、令牌和操作可能被同网攻击者窃听或篡改。仅用于可信家庭网络或个人热点，不用于公共Wi-Fi；HttpOnly/SameSite不能替代传输加密。

## 实施分工

核心实施任务：公共mode契约、双模式gateway/Cookie、Host关闭撤销和重配、UI/非secure-context ID、测试与私网浏览器smoke。共享接口与调用方同一任务串行，避免多任务同文件冲突。

主任务：文档与用例映射、核验集成、统一测试构建、独立包与差异审查。保留上次引擎环境修复的全部未提交改动，不提交/推送。

## 预期验收

- Node功能/HTTP(S)/WS(S)/Host集成；私网HTTP非secure-context实际浏览器配对与WS；原HTTPS回归。
- types/build/storage/桌面与受限PATH回归，证明不回退上次修复。
- 关闭共享旧授权与连接失效，切模式重配，本地任务不结束。
- 新报告新目录，新包独立路径，旧正在运行的包不覆盖、不主动终止。

## 当前结果

| 项目 | 实际结果 |
| --- | --- |
| 主工作区 `pnpm typecheck` / build / storage | 通过 |
| `pnpm test` | 97项通过、0失败 |
| `pnpm test:lan` | 18项通过、0失败，包含HTTP/HTTPS认证、来源与模式切换 |
| `node scripts/smoke-http-browser.mjs --output docs/validation/2026-10-22-http-lan/browser.json` | 真实私网HTTP页面通过；isSecureContext=false，randomUUID不可用，getRandomValues可用；Cookie配对/WS bootstrap/UUID fallback通过，无CA或模型调用 |
| 源码 Shell 桌面 | first / restart两阶段通过，见 desktop/ |
| 受限PATH Agent回归 | first / restart / crash / crash-restart四阶段通过，见 engine-regression/，保留前次修复 |
| 新HTTP包内桌面 | first / restart两阶段通过，见 packaged-desktop/ |

独立新包：`release/http-lan-fixed/mac-arm64/XTerminal.app`，使用 `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --config.directories.output=release/http-lan-fixed` 生成，旧包不替换。包内桌面验证为Electron harness加载实际app.asar，并非人工访达或手机真机验收。

浏览器私网测试使用受控Gateway/空会话与临时目录，不调用真实CLI或模型，不等于真机软键盘/后台恢复已验收。测试设计见 [HTTP用例](../../test-design/2026-10-22-http-lan.md)。独立diff-review已完成：基线为HTTP前源码快照，Correctness 0条已确认finding、Standards 0条硬性违规、Spec 0条已确认偏离，无阻断交付问题。审查以独立只读上下文串行三轴执行，不替代主统一测试。

## 质量门

统一验证后执行diff-review，重点传输选择不能扩大为认证/来源校验绕过。复杂度/覆盖率工具缺失时结构审查降级，不声称获得评分；无突变工具则跳过、不安装依赖。
