# mashang-hub Architecture Boundaries

本文档是 `mashang-hub` 与 `mashang-service` 之间的长期架构边界定义。

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

Hub 可以依赖稳定的协议字段，例如 `taskId`、`turnId`、`conversationId`、`model`、`status` 和 `artifactId`。

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
