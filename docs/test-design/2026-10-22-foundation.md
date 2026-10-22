# 基础契约测试设计

范围：架构 v1.0 的引擎固定、Agent 状态转换、单端控制权与 SQLite 数据约束。

现有设施：此前只有无构建依赖的网页原型，没有领域测试框架。设计采用 Node 自带 test/assert 与 Python 标准库 SQLite 做基础验证，不引入额外测试框架。以下用例交由实施流程编写和执行；本设计不声称已执行。

| 编号 | 依据 | 前置与操作 | 必须断言 |
| --- | --- | --- | --- |
| F01 | PRD 引擎创建后固定 | 已有 claude 会话请求 codex；同引擎请求 claude | 前者拒绝且原会话不变；后者允许 |
| F02 | 停止结果不能伪造完成 | idle → 请求开始 → 引擎开始 → 请求停止 | 状态依次 starting/running/stopping，未确认前不能 idle |
| F03 | 请求输入生命周期 | running → 提问 → 回答 → 完成轮次 | waiting/running/idle，保留轮次连续性 |
| F04 | 崩溃不重跑 | waiting 或 running 收到进程丢失 | interrupted，不自动变 starting/running |
| F05 | 上下文恢复不同于执行 | interrupted → 恢复请求 → 恢复完成 | starting → idle，不自动创建轮次 |
| F06 | 过期/乱序事件 | idle 收到授权回答；stopping 收到晚到提问 | 拒绝无效转换，不让已停止任务回到等待 |
| F07 | 多端互斥 | 电脑控制 generation 1，手机接管到 2 | 电脑旧 stamp 无效，手机 stamp 有效 |
| F08 | 租约到期 | expiresAt=15000，在 14999 和 15000 校验 | 前者有效，后者无效 |
| F09 | Host 重启 | 新旧 Host generation 均为 1，但实例 ID 不同 | 旧实例 stamp 不能控制新 Host |
| F10 | 输入验证 | 空控制主体、非正租期、无效时间 | 拒绝输入，不生成异常租约 |
| S01 | 数据层固定引擎 | SQL 更新 sessions.engine | trigger 拒绝，原字段不变 |
| S02 | 固定项目与初始目录 | SQL 改 project_id 或 initial_cwd | 拒绝；重命名仍可成功 |
| S03 | 不得跨会话绑定运行 | 甲会话消息使用乙 runId | 复合 FK 拒绝 |
| S04 | 一个会话一个活跃实例 | 同会话插入两个 running run；结束第一个后再插入 | 前者拒绝，后者允许 |
| S05 | seq 与 command 去重 | 同 session 重复 seq；同主体/会话重复 commandId | 唯一约束拒绝，不新增第二行 |

未覆盖：真实引擎中断、SDK 认证、端到端命令幂等、授权 CAS 与多进程事务、网络 TLS、终端快照。它们需要后续 Host 与适配器测试，不应由这些纯函数测试替代。
