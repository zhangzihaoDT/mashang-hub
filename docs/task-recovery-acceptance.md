# P0 / P1 / P2 验收记录（2026-10-10）

## 代码阶段

- P0：知识库 V2 独立提交；Publishing 实验默认关闭；版本、控制面职责和镜像 revision 标识收口。
- P1：SQLite 统一 Task Record、Conversation 关联、Runtime 待审批/审批决定、Attempt/Dispatch 和终态持久化。原入口兼容，新增任务查询和一致性备份。
- P2：首个 Agent 长任务纵向场景，按任务执行期限监管、进度静默通知、Worker durable claim / result outbox、重连对账、重复分发拒绝。

不是完整通用调度框架：通用队列、后台任务管理视图、持久化 OpenCode 工具审批、跨 Worker 调度、Worker 重启后的历史 Artifact 下载注册表尚未完成。P3 正式 External Action 仍待凭证隔离和环境接入。

## 实测结果

- 完整 npm test 通过：既有 UI / Artifact / Workspace / Runtime / 发布实验回归，以及 SQLite 与恢复场景。
- npm run test:long-task：真实 Hub + Worker 进程，Mock OpenCode 请求实际持续 **185000 ms**；期间 SIGKILL 重启 Hub，Worker 自动重连；任务 COMPLETED，原 attemptId / dispatchId 保持，模型执行调用次数 **1**。
- npm run test:recovery：实际进程重启与结果回收、心跳不刷新任务进度、旧 Attempt 不生效、离线取消保留请求、完成后迟到失败不覆盖。
- npm run test:task-store：Hub 重启后任务、会话、待审批与驳回记录保留，不自动分发；SQLite VACUUM 快照恢复成功。
- Worker journal 单测：历史 RUNNING 不当作存活证明；相同执行不重复启动；中断、UNCERTAIN 和 durable result 区分；损坏文件拒绝启动。
- 相关 JavaScript 语法检查和 git diff --check 通过。

Mock 验收不使用真实模型、业务数据、微博 API 或凭证。185 秒通过不等于真实 20 分钟业务任务与移动浏览器已验收。

## 部署状态与约束

未部署 Sealos，未修改当前 LaunchAgents，未重启正式 Worker / OpenCode，未真实发布微博。

Docker CLI 存在但 daemon socket 不存在，无法本机镜像构建；构建脚本检查干净提交并绑定 OCI revision / version。镜像与 Node 22 容器内运行仍待 Docker 环境验收。

Hub 必须单实例，挂载持久卷到 /data；生产部署升级前先做数据库快照。Worker journal 包含本地结果且需持久私有目录。旧 Worker 不提供完整对账，升级 Hub 与 Worker 后再验收正式恢复场景。

P3 前置环境与设计见 [publishing-isolation.md](publishing-isolation.md)。
