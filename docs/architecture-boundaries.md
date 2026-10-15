# mashang-hub Architecture Boundaries

本文档是 `mashang-hub` 与 `mashang-service` 之间的长期架构边界定义。

## 业务入口与共享运行能力

业务入口按领域划分，运行基础设施统一复用。Service、Fetch、Knbase、Publish、AKsignal 是同级业务区域；复用 Service Scheduler 不构成 AKsignal 对 Service 的业务归属。

AKsignal 的 Runner、行情、检查点与日报归独立 AKsignal 仓库。Worker 注册确定性业务操作，Hub 仅展示通用运行字段和附件。AKsignal 区域不创建专属 Agent；当前只接入 Market Facts，组合状态与策略能力仍未实现。Scheduler 暂保留在 Service 中作为共享触发能力，不为此次接入拆分新 Scheduler、数据库或执行体系。

## Core Rule

```text
mashang-hub     = Control Plane
mashang-worker  = Local Execution Plane
mashang-service = Business Capability and Data Plane
```

Hub 是通用的业务交互与任务控制层，不是 `mashang-service` 的业务脚本目录索引，也不是另一个 Research Runtime。

## Hub May Understand

Hub 可以理解并管理以下通用对象：

- Conversation
- Turn
- Task
- Model
- Worker
- Event
- Permission
- Artifact
- Timeout / Cancel / Terminal State

Hub 可以依赖稳定的协议字段，例如 `taskId`、`turnId`、`conversationId`、`model`、`status`、`workspaceId` 和 `artifactId`。

`workspaceId` 是不透明标识：Hub 只校验长度与字符集并原样传递，不解析它的业务含义，也不接收本地路径。`workspaceId` 到本地目录的映射只存在于 Worker 的本地 workspace registry。

## Hub Must Not Understand

Hub 不得绑定以下内容：

- 具体 Python、Shell 或其他业务脚本名称
- 业务脚本的内部目录结构
- dataset 的字段、表结构或文件名
- 某个车型、业务主题或研究方法的特殊判断逻辑
- `mashang-service` 内部 capability 的实现细节
- “某句 Prompt 对应某个固定脚本”的硬编码映射

Hub 不应直接读取 `mashang-service` 或 dataset。所有本地执行和本地文件访问必须经过 Worker。

## Change Ownership

业务能力、数据口径、研究流程和本地执行逻辑的变化，优先只修改 `mashang-service`。只要 Worker/Hub 协议没有变化，Hub 不应随业务能力升级而修改。

Hub 只有在以下情况才需要变化：

- 通用 Task / Event / Artifact / Permission 协议变化
- Worker 连接或认证协议变化
- 通用生命周期、超时、取消或恢复语义变化
- 通用 UI 展示能力变化

## Protocol Boundary

业务能力通过 Worker 和 OpenCode 消化。Hub 只传递通用请求：

```text
Browser
  ↓ generic prompt + model
Hub
  ↓ task.create
Worker
  ↓ OpenCode / local capability
mashang-service
```

如果未来引入 capability identity 或参数协议，应保持为稳定、业务无关的接口。Hub 可以展示 capability 的名称和结果，但不应知道它由哪个本地脚本实现。

## Review Gate

新增 Hub 代码时必须检查：

- 是否引入了本地业务绝对路径
- 是否出现具体业务脚本或 dataset 文件名
- 是否把某个业务意图硬编码为某个执行脚本
- 是否让 Hub 直接访问本地文件或数据
- 是否能把该逻辑放到 Worker 或 `mashang-service` 而不改变 Hub 协议

如果只是为了支持一个新业务能力而修改 Hub，默认先暂停并重新检查边界，而不是继续增加映射表。

## Personal Task Orchestrator

Hub 是个人任务编排与控制中心。Conversation 只提供交互与上下文，Task 管理生命周期、审批、调度与恢复。Agent、Operation、External Action 共享通用任务管理层，业务执行仍属于 Worker / Capability。分阶段契约见 [task-orchestration.md](task-orchestration.md)。


## Generic trend comparison metadata (2026-10-15)

`operation.details.trendComparison` is a bounded, provider-authored display schema: title, independent start/end dates, unit, note, at most 1000 shared dates, and at most 12 labelled numerical series. The generic Hub renderer draws paths and legends, breaks lines at nulls, escapes text, and can resolve a report by artifact digest. It does not read datasets, calculate financial returns, choose stock pools, or execute refresh jobs. Provider source rules, current snapshots, admission and adjustment policy remain in the business repository.

Comparison metadata and its pinned report are independent of a formal Daily publication. Their timestamp is displayed explicitly; they do not upgrade batch status or data completeness. The existing Worker artifact root, digest checks, 20 MiB cap and HTML CSP remain unchanged. Interactive HTML can be downloaded; restricted HTML previews retain provider-rendered static SVG fallbacks. The main summary panel renders the comparison after the existing summary; execution controls remain in their original area. These are local source changes until separately deployed.


## Interactive standalone HTML previews (2026-10-15)

The artifact content endpoint runs embedded report scripts in a CSP `sandbox allow-scripts allow-downloads` with an opaque origin. It never grants `allow-same-origin`, top navigation, popups or forms. The response permits only exact SHA256 hashes of inline script blocks (at most 64 unique blocks); external scripts, event handlers, eval, frames and network connections remain blocked. Inline styles and data/blob images support local charts. Artifact authentication, owner checks and pinned content digests remain unchanged. Downloads keep their original bytes and attachment semantics. Existing deliberately sandboxed embedded task iframes may remain static; standalone report links support interaction.

Regression checks cover exact hashes, bounded headers, source restrictions, the real Hub/Worker artifact response and unchanged downloads. Browser verification against the actual research report exercises all four time ranges, excess mode, hiding a trace and restoring all nine traces. An isolated diagnostic page additionally verifies blocked storage/network access while its button remains functional. This change lives only in Hub response handling; it requires a new Hub image, not a Worker restart.
