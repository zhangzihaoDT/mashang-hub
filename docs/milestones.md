# mashang-hub Milestones

这个文件记录 `mashang-hub` 的关键工程里程碑、架构判断和验收结论。它不是临时开发日志，也不是下一阶段任务清单；后续版本应在这里追加新的里程碑，而不是覆盖已有记录。

## 2026-09-23 · V0.2

### Remote Hub + Local Worker Architecture Validated

**状态：已完成架构验证**

`mashang-hub V0.2` 完成了从本地 OpenCode Web UI 到公网命令中枢的跃迁：

```text
Phone / Browser
        ↓ HTTPS / SSE
Sealos mashang-hub
        ↓ outbound WebSocket
Mac mashang-worker
        ↓ localhost
OpenCode Server 127.0.0.1:4096
        ↓
mashang-service / Local Dataset / Capabilities
```

核心边界已经确定：

```text
Cloud = Control Plane
Mac   = Execution Plane
```

Hub 不访问 Mac 文件系统，不承载本地 dataset，不运行 OpenCode；Worker 主动连接 Hub，并在本机访问 OpenCode 与 `mashang-service`。

### 本里程碑完成的能力

- 手机或浏览器可以访问公网 Hub。
- Hub 与 Mac Worker 通过 outbound WebSocket 双向通信。
- Worker 保持 OpenCode 只监听 `127.0.0.1:4096`。
- Browser → Hub → Worker → OpenCode → 本地数据 → Result 链路已打通。
- Worker Online / Offline / Running 状态可反馈到 Hub。
- Hub Session 与 OpenCode Session 分离，并建立 mapping。
- 每个用户 turn 拥有独立 `taskId` 与生命周期。
- 同一个 Conversation 可以保持上下文连续性。
- Task 支持 `COMPLETED`、`FAILED`、`INTERRUPTED`、`TIMEOUT`、`CANCELLED` 终态。
- Hub/Worker 之间支持 task cancel 与 Worker 侧 `AbortController`。
- Soft timeout / hard timeout 已实现并可配置：

```text
TASK_TIMEOUT_MS=180000
TASK_CANCEL_GRACE_MS=10000
```

- Hub 具备 terminal guard，迟到的 running event 不会让终态回退。
- Hub 对空文本、无 Artifact 的 Agent 返回识别为 `EMPTY_RESULT` anomaly。
- Artifact 仅允许来自 output roots，原始 `dataset` 不可作为下载对象。
- Artifact 支持 Markdown、HTML、PNG、CSV 的 Preview / Download 链路。
- Download 通过 Worker 按需读取本地文件，不复制到云端或 Mac Downloads。
- Worker WebSocket 支持 `WORKER_SECRET`。
- Hub 支持 `HUB_ACCESS_TOKEN` 用户认证。
- Turn root、process event、terminal event 同时保存在 Hub 内存和 JSONL 日志中。
- 手机端完成单栏布局、固定底部输入框、safe-area 适配、Debug 折叠和长内容横向滚动。
- iPhone 输入控件字号调整为 `16px`，避免 Safari 点击输入框自动缩放。
- Docker 镜像已支持 `linux/amd64`，并已推送到 Docker Hub。

### 重要架构判断

这次验证明确区分了：

```text
Conversation Session
    = 负责上下文连续性

Task / Turn
    = 负责一次执行、状态、超时、取消和结果

OpenCode Session
    = Worker 侧的 Agent execution context
```

OpenCode Session 可以在 Conversation 内复用，但不能再被当作 Hub Task 的生命周期本身。每个 turn 必须独立拥有：

```text
conversationId
turnId
taskId
openCodeSessionId
model
status
startedAt
lastEventAt
terminalAt
terminalReason
```

这条边界解决了连续对话、迟到事件、forever running、Cancel 和诊断困难等问题。

### 安全边界

- OpenCode 不暴露公网。
- OpenCode 不监听 `0.0.0.0`。
- `mashang-service` 不上传 Sealos。
- dataset 不上传 Sealos。
- Browser 不直接连接 OpenCode。
- Worker 只能读取允许的 Artifact output roots：

```text
outputs/
mashang_workspace/outputs/
```

- 所有 Artifact 路径经过 canonicalize、root 校验、symlink escape 校验和文件类型校验。
- Secret 通过环境变量注入，不写入镜像和 Git 仓库。

### 发布记录

Git：

```text
V0.2 architecture: a181545
Worker machine-path cleanup: 2b2e49f
Mobile layout: b8b0716
iPhone input zoom fix: ff5e5ad
```

Docker：

```text
docker.io/byte1717712/mashang-hub:0.2.2
```

当前镜像目标平台：

```text
linux/amd64
```

### V0.2 的定义完成

本版本完成的不是“Hub 可以打开”，而是完成了下面这条工作流的架构验证：

```text
手机
  ↓
打开 mashang-hub
  ↓
看到 Mac Worker Online
  ↓
输入业务问题并选择模型
  ↓
Hub 创建独立 Task
  ↓
Worker 在本地调用 OpenCode
  ↓
OpenCode 读取本地 mashang-service / dataset
  ↓
手机收到实时状态和 Research Result
  ↓
生成报告时出现 Artifact Card
  ↓
手机 Preview / Download
```

同时满足：

```text
OpenCode 不暴露公网
mashang-service 不上传云端
本地文件系统不能被任意访问
```

### 下一阶段

V0.2 之后，问题不再是“架构能不能成立”，而是进入产品化阶段：

- 账号体系与多用户隔离。
- Worker 常驻化与断线恢复。
- 更完整的移动端交互与结果呈现。
- Capability 资产标准化与可发现性。
- 长期运行监控、告警与成本观测。
- 后续再评估 Intent Router、Capability Resolver 和模型策略。

这些内容不属于本 V0.2 里程碑的完成范围。
