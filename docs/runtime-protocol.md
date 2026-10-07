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

## 演进

- 控制类动作（`up` / `down` / `restart` / `run`）留待后续版本，应以通用 `runtime.control` 请求 + 终态结果 + Permission 门禁单独定义，不复用本快照语义。
- `protocolVersion` 变更时，Hub 与 Worker 需能同时表达旧、新版本；当前只支持 `1`。
