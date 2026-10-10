# Personal Task Orchestrator

Hub 管理通用 Task 生命周期、授权、分发与恢复；Worker 管理本地执行证据、文件与凭证；Capability 管理业务算法和副作用。Conversation 不等于 Task，Task 不等于 OpenCode Session。Hub 不增加业务命令映射。

## 分阶段实施

- P0：拆分知识库 V2 与 Publishing 实验变更，统一版本、文档，默认关闭发布并完成回归。
- P1：SQLite Task Store，统一任务身份与记录，保留 Conversation / Runtime API；重启后任务及待审批记录不丢失。已分发任务恢复后等待对账，绝不自动重放。
- P2：区分心跳、进度静默期限与执行期限；以超过 180 秒的长任务为验收场景，验证 Hub 重启、Worker 断线后的可信对账和不重复执行。
- P3：在 OS 凭证隔离完成后接入受控 External Action，审批绑定正文、范围和声明的不可变快照。原有 OpenCode 工具保留，发布异常进入 UNCERTAIN，禁止自动重试。

每阶段分别提交、测试和验收。P1 不预建完整调度框架；队列与多执行器能力按验收需求引入。

## 身份与状态

conversationId 维护上下文；taskId 标识任务；attemptId 标识一次执行尝试；dispatchId 标识分发；operationId 标识副作用操作。重新发送消息不得自动产生新的 Attempt 或 operationId。

持久化状态包括 CREATED、QUEUED、AWAITING_APPROVAL、DISPATCHED、RUNNING、INTERRUPTED、UNCERTAIN、COMPLETED、FAILED、CANCELLED。后面三个是不可变终态。INTERRUPTED / UNCERTAIN 允许凭可信执行证据对账；UNCERTAIN 不自动重试。

审批等待不计入执行时间。Worker 心跳不证明 Agent 正常推进。重连后的旧 RUNNING 或遗留 PID 不构成执行证明。

## 构建来源

发布镜像必须从干净的、通过测试的提交构建：

```sh
git diff --exit-code
git diff --cached --exit-code
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" --build-arg VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')" -t mashang-hub:<version> .
```

另外用 git status --porcelain 核对无未跟踪源文件。镜像 revision 应与部署记录中的提交一致。此文档不代表已构建或部署新镜像。

`npm run image:build` 自动检查干净工作区，并写入 Git revision 与 package version 的 OCI label。Docker 默认数据库路径为 `/data/tasks.sqlite`，部署必须挂载持久卷；单实例运行。
