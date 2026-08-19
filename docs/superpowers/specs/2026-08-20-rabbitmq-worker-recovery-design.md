# RabbitMQ Worker 与 Core Harness 自动恢复设计

## 背景

2026-08-20 03:29（Asia/Shanghai），一个 NuQ Worker 在任务已经写入 PostgreSQL 终态后，向 RabbitMQ 发送完成通知时遭遇 `ECONNRESET`。异常从 `sendJobEnd()` 继续抛出，使 Worker 进程退出。Core harness 随即关闭 API，但生产模式下无限等待其他长任务 Worker 自行结束，导致 PID 1 仍存活、3002 端口消失、Docker `restart: always` 无法触发。UI 按设计 fail closed，`/readyz` 返回 503。

RabbitMQ 本身没有重启，队列和 PostgreSQL 数据均保留。手工重启 Core 后 API、UI readiness 和队列消费恢复。

## 目标

1. PostgreSQL 已成功提交任务终态后，RabbitMQ 完成通知失败不得使 Worker 退出。
2. 任一 Core 子服务仍意外退出时，harness 必须在有限时间内结束全部子进程并以非零状态退出，让 Docker 自动重启容器。
3. 不改变 NuQ PostgreSQL 任务状态语义，不清理或重建持久队列。
4. 不通过降低业务并发掩盖连接错误。

## 方案比较

### 方案 A：通知容错 + 有界关停（采用）

- 将 RabbitMQ 完成/失败通知视为 PostgreSQL 终态提交后的派生通知。
- 第一次发送失败时丢弃失效 sender，重连并重试一次；第二次失败只记录结构化 warning，`jobFinish()`/`jobFail()` 仍返回数据库更新结果。
- harness 对所有 SIGTERM 子进程设置统一关停上限；到期后终止整个进程组。内部子服务失败仍保留 `serviceError=true`，harness 最终以退出码 1 结束。

该方案直接切断本次两段故障链，同时保留队列的 PostgreSQL 权威状态。

### 方案 B：只延长 RabbitMQ heartbeat 或降低 Worker 数

可减少心跳超时概率，但网络重置仍可能发生，且降低吞吐；不能解决 harness 假存活，因此不采用为主修复。

### 方案 C：增加 autoheal 容器

可在 unhealthy 后重启 Core，但增加额外运行组件，仍不能防止单个通知异常击穿 Worker；不采用。

## 组件与数据流

### NuQ 完成通知

1. `jobFinish()` 或 `jobFail()` 先在 PostgreSQL 原子写入终态。
2. 仅在数据库更新成功且存在 listener ID 时发送 RabbitMQ 通知。
3. 发送异常触发一次 sender 重置、重连和重试。
4. 重试仍失败时记录 queue name、job ID 和错误类别，不记录任务正文；函数继续返回数据库更新成功。
5. 通知重复是允许的：listener 已完成后会忽略后续重复消息。

### Harness 关停

1. 子服务非零退出使 `runProductionMode()` 设置 `serviceError=true`。
2. `gracefulShutdown()` 向全部仍存活的子进程组发送 SIGTERM。
3. 每个子进程最多等待 30 秒；超时后向进程组发送 SIGKILL。
4. 全部清理 Promise 结束后，harness 以退出码 1 退出，Docker `restart: always` 拉起新容器。
5. 被强制终止的 NuQ 任务依靠既有 PostgreSQL 锁超时和 reconciler 重新认领，不修改任务数据模型。

## 错误处理边界

- PostgreSQL 终态更新失败仍必须向上抛出，不能伪装成功。
- 仅 RabbitMQ 派生通知失败可降级；发送前的连接建立、通道关闭和同步写异常都进入同一受控重试路径。
- 正常人工停止和异常关停均采用相同 30 秒上限，确保 Docker 的 60 秒停止窗口内完成。
- 日志不得包含任务正文、凭据或完整连接串。

## 测试

1. NuQ 回归测试：第一次通知发送抛 `ECONNRESET`、第二次成功，数据库终态只写一次且调用返回成功。
2. NuQ 回归测试：两次通知均失败，数据库终态仍成功，产生 warning 而进程不出现未处理 rejection。
3. NuQ 回归测试：数据库更新失败时仍拒绝，不执行通知容错成功路径。
4. 进程关停单元测试：子进程收到 SIGTERM 后及时退出，不发送 SIGKILL。
5. 进程关停单元测试：子进程忽略 SIGTERM，超时后进程组收到 SIGKILL，Promise 有界结束。
6. 现有 Core 聚焦测试、TypeScript 构建、Docker 精确 SHA 构建和 capability 契约全部通过。
7. 生产滚动替换后验证 Core capability 200、UI `/readyz` 200、队列进度继续、无新增 `unknown` 操作。

## 部署与回滚

- 修复提交合并到用户仓库 `main`，使用完整提交 SHA 构建 amd64 Core 镜像。
- 生产仅替换 Core API 容器，RabbitMQ、Redis、NuQ PostgreSQL、UI 和所有数据卷保持不变。
- 回滚只需恢复上一精确 Core 镜像；数据库 schema 和数据无需回滚。

## 验收标准

- 注入 RabbitMQ 通知异常不会退出 Worker。
- 注入不响应 SIGTERM 的子进程后，harness 在 30 秒上限后退出 1。
- Docker 重启后的 capability SHA 与候选提交一致。
- UI readiness 连续保持 200，正式初始化继续推进，`unknown` 和待对账操作为 0。
