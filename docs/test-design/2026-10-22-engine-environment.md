# 桌面引擎环境测试设计

依据：用户已批准的根治方案 `/Users/lixiuxiu/.claude/plans/staged-painting-sutherland.md`；默认测试不调用模型、不读取用户凭据。沿用 Node 原生 `node:test`、临时可执行脚本与既有 Electron 四阶段夹具，不新增测试框架。

| 规则 / 用例 | 输入与操作 | 预期结果 / 禁止副作用 | 验证入口 |
| --- | --- | --- | --- |
| R1 / T1：GUI 路径恢复 | PATH=`/usr/bin:/bin:/usr/sbin:/sbin`，临时 HOME 下 `.nvm/versions/node/v24.0.0/bin` 有假 CLI；启动 Host | 两引擎可用；实际使用临时 CLI，不搜索用户 HOME | resolver / engine-environment 单测 + Electron `--restricted-path` |
| R1 / T2：优先级 | 当前 PATH 与 shell PATH 各有不同假 CLI；常见目录同时有 v9 和 v24 | 当前 PATH 优先，未命中再用 shell；数字版本排序优先 v24 | resolver 单测 |
| R2 / T3：env-node | 假 CLI 用 `#!/usr/bin/env node`，系统 PATH 没 Node，安装 bin 有 Node | 检测、模型列表、轮次可运行；不用 Electron 当 Node；不修改 process.env | engine-environment 单测 + Electron四阶段 |
| R3 / T4：链路一致 | 注入标记路径/env，先 initialize 再 models/start | 三处收到同一引擎 target/env；两引擎 env 不串用 | agents 单测 |
| R4 / T5：显式覆盖 | override 指向不存在/不可执行文件，同时 PATH 有有效假 CLI | 明确不可用，不执行 PATH 里的替代CLI；允许有效带空格路径、符号链接、~/ | resolver 单测 |
| R5 / T6：shell失败 | 假 shell 输出前后噪声、非零退出、超过超时、输出不合法PATH | 标记正确提取；失败有界降级；UI/日志不包含原始输出；相对项/空项不作为CLI目录 | resolver 单测 |
| R6 / T7：隔离 | 原有测试只注入 detect/createRuntime，调用 host.ready() | 不启动真实 shell、不执行用户 CLI；定位有隔离默认或显式注入 | agents/controller/LAN 回归 |
| R3 / T8：约束保留 | 假 Claude 版本不匹配、未登录、非法JSON；假 Codex 正常版本 | 原版本/认证规则保留；失败有解释，不泄漏 auth对象/CLI stderr | runtime 单测 |
| R1-R3 / T9：打包集成 | 精简PATH与隔离home，harness加载新 app.asar 的 main/Host | 两引擎创建、模型列表、回复、审批、停止、重启恢复通过；不冒充人工访达验收 | `--restricted-path --package-entry <包内main.cjs>` |

现有 Claude 检测测试仅覆盖成功版本/登录及隐私白名单；Codex 仅覆盖路径不存在。现有 Electron 夹具把 bin 放进 PATH，不能证明 GUI 路径恢复。以上为补充设计，执行结果由实施工作流独立记录。

验证缺口：真实访达人工操作、真实用户自定义 shell 所有组合和真实模型请求不由夹具替代。文件安装后被删除/权限改变时，应由 Runtime 启动错误处理保证任务失败而非伪装成功。
