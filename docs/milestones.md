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

## 2026-10-07 · V0.4 Launchd Runtime

### 登录后自动托管 OpenCode + Mac Worker

日常运行不再依赖进入仓库执行 `npm run up`。macOS 用户级 LaunchAgent 在登录后自动启动并持续托管两个进程：

```text
OpenCode     Worker dependency，本地 Agent Runtime
Mac Worker   Execution Plane 本身，outbound WSS 连接远程 Hub
```

Hub 正式环境仍是 Sealos 控制面，不在本机 launchd 启动；`mashang-fetch`、`myknbase`、`mashang-service scheduler` 与 daily jobs 都不在 launchd 托管范围内。

### 边界

- launchd 只托管 OpenCode 与 Mac Worker 两个 agent。
- Worker 通过 `HUB_URL` 连接 Sealos Hub，Hub 不落本机。
- 现有 `npm run up/down` 与 `scripts/dev.sh` 保留为本地开发模式（含本地 Hub）。
- 开发模式启动前会检测 launchd agent，存在时明确拒绝，避免重复实例。
- Worker secret 写入用户级 plist（`600`），`launchd:status` 不回显环境变量。

### Smoke Test 结果

```text
launchd:status                      OpenCode / Worker 均 running
kill OpenCode → 自动恢复            新 PID，OpenCode 健康接口恢复 HTTP 200
kill Worker → 自动恢复              新 PID，重连 Sealos :443 与本地 OpenCode
Mac 重启后无命令自动恢复             重启后约 1 分钟两个 agent 自动拉起并重连
launchd 运行期间 npm run up         被防重保护拦截，两 agent PID 不变
```

### 发布记录

Git：

```text
Add launchd runtime management: 6bb0d8d
Redact launchd status details: 0283528
```

Docker：

```text
docker.io/byte1717712/mashang-hub:0.2.4
docker.io/byte1717712/mashang-hub:latest
```

镜像目标平台 `linux/amd64`，Sealos 正式环境指向该镜像。

## 2026-10-07 · V0.5 Runtime Operation Contract

### Worker 声明通用 operation，Hub 只消费 metadata/status

把原先由 Hub「认识」的 `daily` job 迁移为 Worker 侧的通用 operation，`daily` 与全量更新（`allupdate`）作为首批迁移对象。Hub 不再按 operation ID 分支，也不新增任何 `mashang-service` 专用命令映射。

```text
Worker registry (Service/Worker 侧)
  → runtime.snapshot.operations[]  (metadata + status)
  → Hub 白名单校验，通用渲染 / 授权 / 取消
  → runtime.control run <opaque-id>
  → Worker 执行，回传通用 status + reason
```

### 本里程碑完成的能力

- 修复 Daily 状态识别：同时识别当前 `refresh_daily` 与历史 `refresh_full`，并补回归测试。
- 新增 Worker-side generic operation contract：
  - metadata：`id`、`label`、`group`、`description`、`enabled`、`cancellationSupported`、`timeoutMs`。
  - status：`IDLE`、`RUNNING`、`COMPLETED`、`FAILED`、`CANCELLED`，附运行时间与简短安全摘要。
- 操作状态持久化在 Worker 本地，Worker 重启后可回读。
- 复用既有 Permission 门禁、看门狗、取消与终态语义；operation 可声明建议超时，Hub 全局配置仍可覆盖且设有上限。
- `daily` 与 `allupdate` 迁移为 operation；`allupdate` 支持手动触发，并展示本地写入副作用说明。
- Hub 抽屉按通用 metadata/status 渲染 operation；测试用一个新增无参数 operation 验证无需改动 Hub。

### 验收标准

```text
mashang-service 新增一个无参数 operation：
只修改 Service/Worker，无需修改 Hub 命令映射或业务逻辑。
```

### 发布记录

Git：

```text
Add generic runtime operation contract: 73d3001
```

Docker：

```text
docker.io/byte1717712/mashang-hub:0.2.6
docker.io/byte1717712/mashang-hub:latest
```

镜像目标平台 `linux/amd64`，Sealos 正式环境指向该镜像。

## 2026-10-21 · V0.6 Content CLI

### 目标驱动的 Content 记录入口稳定

Content CLI 从「对话 + 手动指令」收敛为目标驱动的记录入口。用户选择 Notes 或 Flomo，输入已经产生的内容，系统自动完成整理、本地保存或 Flomo 同步。Content 不负责和用户讨论内容，只负责把内容变成可长期保存的知识资产。

### 稳定行为

- `mashang content notes` / `mashang content flomo` 两种启动方式。
- 单行回车直接整理并保存/同步。
- 多行粘贴通过 bracketed paste 识别完整开始/结束边界，内容累计。
- 提示符内显示 `[pasted~Nlines]`，不打印正文预览。
- 粘贴结束不自动保存，按 Enter 才提交整个粘贴块。
- 失败时直接展示原因；按 Enter 重试或重新检查，不要求记忆命令。
- `/paste` + `/end` 作为显式多行输入。
- `/exit`、Ctrl+C、Ctrl+D 退出；退出不取消已提交记录。
- 交互命令收敛为 `/paste`、`/end`、`/exit`；任务状态、恢复、幂等和模型选择保留在 Hub / Worker 后端。

### 边界

- Web 端 Content 能力保持不变。
- Notes / Flomo 继续复用既有 Worker 业务工作流、受限授权、任务持久化与去重。
- Content CLI 不新增内容存储，不扩展为通用 Hub 交互终端。

## 2026-10-21 · V0.6.1 Content CLI Paste Composition

### 连续粘贴保留片段标记并合并提交

修复 Content CLI 多段粘贴的可见性与组合边界：

- 每个粘贴片段保留自己的 `[pasted~Nlines]` 标记，连续粘贴显示为 `[pasted~11lines][pasted~11lines]`，不再用累计总数覆盖前一段。
- 手动输入保留原文，直接显示在片段标记之间，不生成 `[typed]` 标签。
- 忽略终端在分段粘贴之间附加的换行，避免第一段被提前提交；之后的明确 Enter 才提交。
- 提交时所有粘贴片段和手动输入按顺序合并为一条记录。
- 新增组合与粘贴边界回归测试。

版本号：`0.6.1`。
