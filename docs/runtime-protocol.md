# Worker ↔ Hub Runtime Protocol (V1)

本文档定义 `mashang-worker` 向 `mashang-hub` 暴露本地 Runtime 状态的最小协议。

这是**通用协议**：Hub 只接收、校验、保存和展示运行时条目，不解释它们是什么。本地 registry 的语义（canonical 启动入口、脚本名、本地路径、日志路径、legacy 判定）全部留在 Worker。

## 边界

- Hub 不接收本地路径、命令、PID、URL、日志路径、原始错误详情或内部失败步骤。
- Hub 只理解稳定字段：`id`、`label`、`status`、`managed`、`lastRun`。
- 服务与任务的身份由 Worker 的 registry 定义；Hub 把它们当作不透明的通用条目。
- 本版本只有只读状态的 Worker→Hub 推送，没有 `runtime.control` 或任何 Hub→Worker 控制消息。

## 消息：`runtime.snapshot`

Worker 连接后在 `worker.register` 之后立即发送一次，随后周期性重发。周期由 Worker 实现参数控制（默认 30 秒，`RUNTIME_SNAPSHOT_INTERVAL_MS`），**协议本身不规定周期**。

```json
{
  "type": "runtime.snapshot",
  "protocolVersion": 1,
  "workerId": "local-worker",
  "sequence": 1,
  "generatedAt": "2026-10-07T02:00:00.000Z",
  "services": [
    { "id": "fetch", "label": "mashang-fetch", "status": "ONLINE", "managed": false }
  ],
  "jobs": [
    {
      "id": "daily",
      "label": "mashang-service daily pipeline",
      "lastRun": {
        "status": "FAILED",
        "startedAt": "2026-10-07 09:00:01",
        "finishedAt": "2026-10-07 09:00:01"
      }
    }
  ]
}
```

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 固定 `runtime.snapshot` |
| `protocolVersion` | number | 当前为 `1` |
| `workerId` | string | Worker 身份 |
| `sequence` | number | 当前连接内单调递增；Hub 丢弃重复或过期序号 |
| `generatedAt` | string | Worker 生成时间，仅供参考 |
| `services[]` | array | 服务条目 |
| `services[].id` | string | 稳定机器标识 |
| `services[].label` | string | UI 展示名 |
| `services[].status` | enum | `ONLINE` \| `OFFLINE` \| `UNKNOWN` |
| `services[].managed` | boolean | 是否由 Worker Runtime Manager 跟踪管理 |
| `jobs[]` | array | 任务条目 |
| `jobs[].id` | string | 稳定机器标识 |
| `jobs[].label` | string | UI 展示名 |
| `jobs[].lastRun.status` | enum | `COMPLETED` \| `FAILED` \| `RUNNING` \| `UNKNOWN` |
| `jobs[].lastRun.startedAt` | string \| null | 最近一次运行的开始时间 |
| `jobs[].lastRun.finishedAt` | string \| null | 最近一次运行的结束时间 |

Hub 收到快照后按白名单清洗字段、校验枚举并限制条目数量。无效或版本不匹配的消息被丢弃。

## Hub HTTP 接口：`GET /api/runtime`

返回 Hub 视角的只读视图。`receivedAt` 由 **Hub 生成**，不信任 Worker 时间。

```json
{
  "workerOnline": true,
  "receivedAt": "2026-10-07T02:00:01.000Z",
  "snapshot": { "...": "清洗后的 runtime.snapshot" }
}
```

- 无快照时 `snapshot` 为 `null`，`receivedAt` 为 `null`。
- Worker 断开后保留最后一份快照，`workerOnline` 变为 `false`。
- 有效更新同时进入现有 SSE 广播流（事件 `type: "runtime.snapshot"`）。

## 控制：`runtime.control`（V1）

控制是独立于状态快照的请求/终态语义。Hub 只传递通用的 `op` 与 `targetId`，不解释目标是什么。所有控制动作都是副作用操作，必须经过 Hub 的 Permission 门禁后才下发到 Worker。

操作集：`up` | `down` | `restart` | `run`（均为小写）。

### 生命周期

```text
AWAITING_PERMISSION ──approve──▶ RUNNING ──worker result──▶ COMPLETED / FAILED / REFUSED
        │                            └──timeout/cancel────▶ TIMEOUT / CANCELLED
        └──reject──────────────────────────────────────────▶ REJECTED
```

终态：`COMPLETED` | `FAILED` | `REFUSED` | `REJECTED` | `TIMEOUT` | `CANCELLED`。

### Hub HTTP 接口（需登录）

`POST /api/runtime/control`：

```json
{ "op": "up", "targetId": "scheduler" }
```

→ `202 { "controlId": "control_...", "op": "up", "targetId": "scheduler", "status": "AWAITING_PERMISSION", "reason": null, "code": null, "createdAt": 0, "updatedAt": 0 }`

`POST /api/runtime/controls/:id/decision`：`{ "approve": true }`
`POST /api/runtime/controls/:id/cancel`
`GET /api/runtime/controls` / `GET /api/runtime/controls/:id`

### Hub → Worker 消息

```json
{ "type": "runtime.control.request", "controlId": "control_...", "op": "up", "targetId": "scheduler" }
{ "type": "runtime.control.cancel", "controlId": "control_...", "source": "user" }
```

### Worker → Hub 消息

```json
{ "type": "runtime.control.result", "controlId": "control_...", "status": "COMPLETED", "reason": "OK", "code": null }
```

- `status` ∈ `COMPLETED` | `FAILED` | `REFUSED` | `CANCELLED`。
- `reason` 是**稳定、业务无关**的机器码（如 `OK`、`UNKNOWN_TARGET`、`UNKNOWN_OP`、`JOB_FAILED`、`EXEC_FAILED`、`UNVERIFIED`、`REFUSED`、`CANCELLED`）；不携带本地路径、命令或原始错误文本。
- `code` 为可选的子进程退出码。

### Hub SSE 事件

- `runtime.control.permission.requested` `{ controlId, op, targetId }` — 需要用户决定。
- `runtime.control.updated` `{ controlId, op, targetId, status, reason, code }` — 每次状态变化（含终态）。

### 超时与取消

- Hub 在批准并下发后启动看门狗：`CONTROL_TIMEOUT_MS`（默认 300000）后软超时，向 Worker 发送 `runtime.control.cancel`；再过 `CONTROL_CANCEL_GRACE_MS`（默认 10000）强制终态 `TIMEOUT`。
- 用户取消走 `POST /api/runtime/controls/:id/cancel`；先到者生效，若 Worker 已返回终态则不再回退。
- Worker 断开时，所有非终态控制被判定为 `FAILED`（`WORKER_DISCONNECTED`）。

## 演进

- `protocolVersion` 变更时，Hub 与 Worker 需能同时表达旧、新版本；当前只支持 `1`。
- Hub UI 只读阶段不包含控制按钮；控制闭环先以 HTTP 接口与协议实现。
