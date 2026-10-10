# mashang-hub

Personal Task Orchestrator — 个人任务编排与控制中心。

代码版本以 package.json 为准；部署版本以实际镜像 revision 为准。历史 V0.x 是能力里程碑，不等同于 npm 版本。

Cloud control plane plus local execution worker. Hub does not access the local dataset or OpenCode directly. Worker is the only component that connects to `127.0.0.1:4096` and reads `mashang-service`.

永久里程碑档案：[`docs/milestones.md`](docs/milestones.md)

架构边界：[`docs/architecture-boundaries.md`](docs/architecture-boundaries.md)

## Architecture

```text
Phone / Browser
       |
 HTTPS + SSE
       v
mashang-hub control plane
       ^
       | outbound WSS / WebSocket
       v
mashang-worker on Mac
       |
       +-- http://127.0.0.1:4096 OpenCode
       +-- local mashang-service and dataset
```

The Hub persists task and conversation metadata in SQLite; artifact metadata remains in memory. Worker maps Hub Session IDs to OpenCode Session IDs. OpenCode IDs are not treated as browser IDs.

## Local Run

### One-click (recommended)

`scripts/dev.sh` starts and stops all three processes (opencode, hub, worker) together, tracks their PIDs in `.local/pids/`, and writes logs to `.local/logs/`. It only manages the processes it started, skips a service whose port is already in use, and never launches a duplicate instance.

```bash
npm run up       # start opencode + hub + worker
npm run down     # stop all three
npm run restart  # stop then start
npm run status   # show running state, PID files and log paths
npm run logs     # tail all three logs
```

Open <http://localhost:3000> after `npm run up`.

Optional overrides (environment variables):

```bash
PORT=3001 \
HUB_HOST=127.0.0.1 \
OPENCODE_PORT=4096 \
WORKER_SECRET=local-worker-secret \
MASHANG_SERVICE_ROOT=$HOME/Documents/github/mashang-service \
HUB_ACCESS_TOKEN=<private-user-token> \
npm run up
```

`scripts/dev.sh` also accepts `start|stop|restart|status|logs` directly. Setting `HUB_ACCESS_TOKEN` enables the browser login gate.

### Login-time Runtime (macOS launchd, V1)

For the Sealos deployment, a per-user LaunchAgent can start and keep **only OpenCode and Mac Worker** running after login. The Worker connects to the remote Hub through `HUB_URL`; this does not launch `server.mjs` locally and does not manage mashang-fetch, myknbase, the scheduler, or jobs.

First stop any development-mode OpenCode/Worker process (`npm run down`), then install with the Sealos Hub URL and Worker secret:

```bash
HUB_URL=https://<sealos-domain> \
WORKER_SECRET=<private-worker-secret> \
MASHANG_SERVICE_ROOT=$HOME/Documents/github/mashang-service \
npm run launchd:install
```

`HUB_URL` must use HTTPS except for a loopback development URL. The installer records absolute Node/OpenCode executable paths, creates two plists under `~/Library/LaunchAgents`, and stores logs under `~/Library/Logs/mashang-hub`. The Worker secret is stored in the per-user plist with mode `600`; keep the account private. Set `OPENCODE_BIN` if `opencode` is not on the current shell's `PATH`.

```bash
npm run launchd:status    # inspect the two user agents
npm run launchd:restart   # restart OpenCode and Worker
npm run launchd:logs      # follow their logs
npm run launchd:uninstall # unload and remove only these two agents
```

The agents use `RunAtLoad` and `KeepAlive`, so they start at login and are relaunched if they exit. `npm run up/down` and `scripts/dev.sh` remain the separate local development mode, including its local Hub process; use `launchd:uninstall` to stop managing the login agents.

### Manual (three terminals)

Terminal 1:

```bash
cd ~/Documents/github/mashang-service
opencode serve --hostname 127.0.0.1 --port 4096
```

Terminal 2:

```bash
cd ~/Documents/github/mashang-hub
WORKER_SECRET=local-worker-secret npm start
```

Terminal 3:

```bash
cd ~/Documents/github/mashang-hub
HUB_URL=ws://127.0.0.1:3000 \
WORKER_SECRET=local-worker-secret \
MASHANG_SERVICE_ROOT=$HOME/Documents/github/mashang-service \
npm run worker
```

Open <http://localhost:3000>. For user authentication, also set `HUB_ACCESS_TOKEN`; the UI will show a login page. Without it, local development has no user login gate.

## Runtime Manager (V0.3 Local Control)

The Mac Worker side carries a services/jobs/operations registry and a small `mashang` CLI. The registry declares state probes, log sources and canonical entries for runtime controls. Generic operations expose only metadata and status to Hub; their local execution entries stay in the Worker.

```bash
npm link                   # once, exposes the `mashang` command
mashang status             # service health + latest job/operation results
mashang status --json
mashang status --strict    # exit 1 if any service is offline or job/operation failed

mashang up <service>       # start via the canonical entry, then verify online
mashang down <service>     # stop the managed instance / declared stop entry, then verify
mashang restart <service>
mashang run <job|operation> # run a declared job or no-argument operation

mashang logs [id] [--lines N] [--follow] [--all] [--json]
```

Services: `fetch`, `myknbase`, `scheduler`. Operations: `daily`, `allupdate`.

Safety model:

- The registry records one canonical entry per service. The scheduler registers `caffeinate -i make sales-scheduler` only — retired scripts (e.g. `schedule_launch_lock_evening_updates`) are listed as `legacy` and are never treated as a valid online service.
- `up` is a no-op when the canonical process is already running, so a stale process is never "re-legitimized". If only a legacy process exists, `up` warns and starts the canonical entry; `down` refuses to stop legacy-only processes.
- Instances started by `mashang` are tracked under `MASHANG_RUNTIME_DIR` (default `<hub>/.local/runtime/`) and stopped by process group. `status` marks untracked running instances as `(unmanaged)`.

Without linking, use `node worker/mashang.mjs <command>`. Configure via `MASHANG_SERVICE_ROOT`, `MASHANG_HUB_ROOT`, `MASHANG_FETCH_ROOT`, `MYKNBASE_ROOT`, `MASHANG_RUNTIME_DIR`, `MASHANG_SCHEDULER_SERIES`, `OPENCODE_URL`, `MASHANG_FETCH_URL`, `MYKNBASE_URL`, or an optional `MASHANG_RUNTIME_CONFIG` JSON override (read by both the CLI and the Worker). The Hub exposes the same runtime over the protocol below.

### Runtime status over the Hub protocol

The Worker pushes a generic `runtime.snapshot` to Hub after `worker.register` and then periodically (`RUNTIME_SNAPSHOT_INTERVAL_MS`, default 30000). Hub sanitizes it against a field whitelist and exposes the latest view at `GET /api/runtime`:

```json
{ "workerOnline": true, "receivedAt": "2026-10-07T02:10:45.730Z", "snapshot": { "services": [], "jobs": [], "operations": [] } }
```

`receivedAt` is generated by Hub, never trusted from the Worker. The snapshot carries only generic metadata and status; local paths, commands, PIDs, probe URLs and raw errors never leave the Mac. The Hub renders it in the **Runtime** drawer (topbar → Runtime), updating live from the `runtime.snapshot` SSE event.

### Local control in the Runtime drawer

The Runtime drawer shows each service with `up` / `down` / `restart` buttons and each job or operation with a `run` button. Clicking one creates a control that is held at the permission gate; approving it there dispatches to the Worker and the terminal state is shown inline (`runtime.control.permission.requested` / `runtime.control.updated` over SSE).

### Local control over the Hub protocol

Control uses generic `runtime.control` request/terminal semantics. The Hub is a permission gate: it never forwards a control action to the Worker until it is approved.

```bash
curl -X POST /api/runtime/control -d '{"op":"up","targetId":"scheduler"}'   # -> AWAITING_PERMISSION
curl -X POST /api/runtime/controls/<id>/decision -d '{"approve":true}'     # -> RUNNING then COMPLETED
curl -X POST /api/runtime/controls/<id>/cancel
curl /api/runtime/controls/<id>
```

- Ops: `up` | `down` | `restart` | `run`; `targetId` is a registry service, job or opaque operation id.
- Terminal states: `COMPLETED`, `FAILED`, `REFUSED`, `REJECTED`, `TIMEOUT`, `CANCELLED`.
- Worker replies with a stable, business-neutral `reason` code (`OK`, `UNKNOWN_TARGET`, `UNKNOWN_OP`, `JOB_FAILED`, `EXEC_FAILED`, `UNVERIFIED`, `REFUSED`, `CANCELLED`) plus an optional `code`. Local commands and paths never cross the boundary.
- Hub watchdog: `CONTROL_TIMEOUT_MS` (default 300000) then cancel, `CONTROL_CANCEL_GRACE_MS` (default 10000) then `TIMEOUT`.
- SSE events: `runtime.control.permission.requested` and `runtime.control.updated`.
- The Runtime drawer drives this same flow with buttons; the HTTP API remains available for scripting. Full contract: [`docs/runtime-protocol.md`](docs/runtime-protocol.md).

## Production Environment

Hub:

```bash
HOST=0.0.0.0
PORT=3000
HUB_ACCESS_TOKEN=<private-user-token>
WORKER_SECRET=<private-worker-secret>
```

Worker:

```bash
HUB_URL=https://<sealos-domain>
WORKER_SECRET=<private-worker-secret>
OPENCODE_URL=http://127.0.0.1:4096
MASHANG_SERVICE_ROOT=$HOME/Documents/github/mashang-service
npm run worker
```

The Worker initiates the WebSocket connection. OpenCode remains bound to `127.0.0.1`; it is never exposed by Hub or Docker.

## Turn Lifecycle (Layer A)

Each user turn is an independent task with its own terminal state. Conversation context stays on one OpenCode session, but execution state is per turn.

```text
IDLE → UNDERSTANDING → RUNNING → RENDERING → COMPLETED
                                       └────→ FAILED / TIMEOUT / CANCELLED
```

Terminal states: `COMPLETED`, `FAILED`, `INTERRUPTED`, `TIMEOUT`, `CANCELLED`. Once a turn is terminal, late `task.running` or OpenCode busy events cannot regress it.

Timeouts (both configurable):

```bash
TASK_EXECUTION_DEADLINE_MS=900000 # default execution deadline (15 minutes)
TASK_PROGRESS_TIMEOUT_MS=180000   # notify when no task progress
TASK_TIMEOUT_MS=180000            # legacy deadline override, if explicitly set
TASK_CANCEL_GRACE_MS=10000    # grace before hard timeout
```

- Soft timeout: broadcasts `task.timeout.warning`, shows "运行超时，正在尝试取消", and sends `task.cancel` to the Worker.
- If cancellation is not acknowledged during the grace period, retain `INTERRUPTED` / `UNCERTAIN` and wait for execution evidence; do not claim the process stopped.
- Worker aborts the in-flight OpenCode request through an `AbortController`.

Cancel is a request, not an immediate verdict. The first valid terminal state wins: if the Worker returns normally before the cancel takes effect, the turn settles `COMPLETED`; otherwise it settles `task.cancelled` / `USER_CANCELLED`.

## Turn Log

Every turn writes a fixed JSONL record to `HUB_TURN_LOG` (default `~/.mashang-hub/turns.jsonl`) and keeps it in memory. `GET /api/turns/:taskId` returns the record. Logs contain ids, event names, reasons and timings; never prompt text, answers or secrets.

```json
{"record":"turn","conversationId":"hub_...","turnId":"turn_001","taskId":"task_...","openCodeSessionId":null,"model":"deepseek/deepseek-flash","status":"SUBMITTING","startedAt":"...","lastEventAt":"...","terminalAt":null,"terminalReason":null}
{"record":"event","taskId":"task_...","event":"opencode.request.sent","ts":"..."}
{"record":"event","taskId":"task_...","event":"task.timeout","reason":"WORKER_REQUEST_TIMEOUT","elapsedMs":180042,"ts":"..."}
```

## Protocol

Hub to Worker messages include `task.create`, `task.cancel`, `artifact.request`, `runtime.control.request`, `runtime.control.cancel`, and `permission.reply`. Worker to Hub messages include `worker.register`, `worker.heartbeat`, `worker.status`, `runtime.snapshot`, `runtime.control.result`, `task.accepted`, `task.running`, `opencode.request.sent`, `opencode.progress`, `opencode.response.received`, `opencode.request.aborted`, `task.completed`, `task.cancelled`, `task.failed`, `task.interrupted`, `agent.message.completed`, `artifact.created`, `permission.requested`, and `session.mapped`.

Each task contains:

```json
{
  "type": "task.create",
  "taskId": "task_...",
  "sessionId": "hub_...",
  "turnId": "turn_001",
  "prompt": "...",
  "model": {
    "providerID": "deepseek",
    "modelID": "deepseek-flash"
  },
  "workspaceId": "myknbase"
}
```

`workspaceId` is optional and opaque to the Hub: it only enforces shape/size (`[A-Za-z0-9_-]{1,64}`) and forwards it unchanged. The Worker resolves it against a **local** workspace registry (`worker/workspaces.mjs`), which maps each id to a project directory and its artifact output roots. Missing/empty ids use the `default` workspace (the Worker's `MASHANG_SERVICE_ROOT`); unknown ids make the Worker fail the task neutrally with reason `UNKNOWN_WORKSPACE`. A Hub Session maps to one OpenCode Session **per workspace**, since each workspace is a different OpenCode project.

The Worker advertises only `{ id, label }` per workspace in `worker.register`; the Hub exposes them at `GET /api/workspaces`. Local roots never cross the boundary. Workspaces are configured in the Worker via `MYKNBASE_ROOT` (registers the `myknbase` workspace), `MASHANG_SERVICE_ROOT` (the `default` workspace) and an optional `MASHANG_WORKSPACES_CONFIG` JSON file.

`task.cancel` carries `{ taskId, source: "timeout" | "user" }`; the Worker echoes `source` back on the resulting `task.cancelled`.

The Worker sends the model to OpenCode as `model: { providerID, modelID }` for that turn only.

## Security

- Browser APIs require the `HUB_ACCESS_TOKEN` login session when configured.
- Worker WebSocket requires `WORKER_SECRET` in the Authorization header.
- Secrets are environment variables and are not sent to the browser or Debug UI.
- Worker rejects absolute paths, `..`, symlink escape and files outside `MASHANG_SERVICE_ROOT`.
- Artifact detection is additionally limited to `outputs/` and `mashang_workspace/outputs/`; raw `dataset/` files are never downloadable artifacts.
- Remote artifact reads are on-demand and stream through Hub; files are not copied to cloud storage.
- HTML artifacts use CSP and a sandboxed iframe.

## Artifacts

Worker validates and announces `.md`, `.html`, `.csv`, and `.png` files under the output roots as opaque Artifact IDs. Hub requests content from Worker only after a user Preview or Download action. The browser never receives the local absolute path.

## Docker / Sealos

Build and run the control plane:

```bash
npm run image:build
docker run --rm -p 3000:3000 -v mashang-hub-data:/data \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e HUB_ACCESS_TOKEN=<private-user-token> \
  -e WORKER_SECRET=<private-worker-secret> \
  mashang-hub:0.3.1
```

Configure Sealos ingress for HTTPS and use the resulting `https://` URL as the Worker `HUB_URL`. The actual Sealos deployment and phone-over-cellular test are not performed by this repository change.

## Known Limitations

- Hub task and approval records survive restart in SQLite. In-flight tasks await Worker reconciliation; automatic replay is disabled.
- Worker session mappings are persisted best-effort to a local JSON file; this is not full task recovery.
- One active Worker is supported; there is no scheduling or multi-worker routing.
- Artifact payloads are base64 encoded in the WebSocket response and capped at 20 MB on the Worker.
- Full browser/mobile and Sealos deployment acceptance still require manual environment testing.

The `myknbase` Worker service and workspace now point to V2 (`~/Documents/github/mashang-knbase`), displayed as **mashang-knbase**, at `http://127.0.0.1:4317`. The Worker starts it with `npm start` and probes `/api/tree`. `MYKNBASE_ROOT` and `MYKNBASE_URL` remain available as overrides. V1 (`~/Desktop/myknbase`, port 7870) is no longer the default.

## 对话文字发布（实验，默认关闭，待凭证隔离）

本地 Worker 可通过 `MASHANG_PUBLISH_ENABLED=1` 启用受控文字发布入口。用户在原窗口输入“把这段文字发布到微博：正文”，查看正文、公开范围和内容声明后回复“确认发布”。执行仍由独立 mashang-publish CLI 完成；Hub 不访问微博凭证。

启用此模式会将该 Worker 创建的所有 Hub OpenCode 会话工具权限设为 deny-all，防止 Agent 用 Shell 绕过确认。因此原有 Agent 工具能力会受限；当前不支持同时开放任意本地执行工具。发布依靠 Worker 持久化确认与防重记录，异常保持 UNCERTAIN，不自动重试。配置、Mock 验证、恢复约束和待真实验收项见 [对话发布验收报告](docs/publishing-acceptance.md)。本轮没有部署或真实发布。

正式 Publishing 启用的前置条件是 OS 凭证隔离，并保留 OpenCode 普通工具。现有 deny-all 模式仅用于实验验收，不是正式方案。实施计划见 [任务编排演进](docs/task-orchestration.md)。

## Task Store（P1）

需要 Node >=22.13。默认数据库为 `.local/tasks.sqlite`，可通过 `HUB_TASK_DB` 设置绝对路径。新增 `GET /api/tasks` 与 `GET /api/tasks/:taskId` 返回通用任务记录；Conversation 和 Runtime 入口保持兼容。任务数据库不保存 prompt、回答、业务正文或本地路径。会话标题持久化为通用标题。

生产环境必须将 `HUB_TASK_DB` 指向持久化卷（例如 `/data/tasks.sqlite`）；仅支持单 Hub 实例写入，不允许多个副本或网络共享 SQLite 文件。启用 WAL、FULL synchronous 和事务。数据库版本通过 user_version 管理；新版本数据库不能由旧代码打开。升级前备份，回滚时恢复匹配版本的备份，不能只回滚镜像。

运行 `HUB_TASK_DB=/data/tasks.sqlite npm run task:backup -- /backup/tasks.sqlite` 创建一致性快照（目标必须不存在）；备份需另存到独立持久存储，并定期验证恢复。不要仅复制运行中的主文件而忽略 WAL。原 JSONL 继续用于审计。P1 不恢复回答和 Artifact 内容，也不自动重放待审批或已分发任务。

## Long Tasks and Recovery（P2 首个纵向场景）

每个 Agent Task 支持 `policy.executionDeadlineMs` 与 `policy.progressTimeoutMs`（默认执行 15 分钟、进度静默 3 分钟，执行上限默认 24 小时）。未配置旧 `TASK_TIMEOUT_MS` 时不再使用统一 180 秒期限；显式旧配置仍作为默认期限兼容。审批等待不计入执行时间。Worker 心跳只证明在线；真实 OpenCode 消息事件更新进度，静默仅通知，执行期限到达后请求取消。

Worker 将执行 claim 和结果 outbox 持久化到 `WORKER_EXECUTION_JOURNAL`（默认 `<WORKER_STATE_FILE>.executions.json`）。重连按 taskId / attemptId / dispatchId 对账，仅本 Worker 进程内真实活跃的执行可恢复 RUNNING；历史 RUNNING 文件不是存活证明。已完成结果可回传，但不重新执行。Worker 重启且无法验证执行时保持 INTERRUPTED，可能存在外部副作用时保持 UNCERTAIN。UNCERTAIN 不自动重试。

更新 Hub 与 Worker 后才能获得完整恢复语义；旧 Worker 保持兼容但无法提供可信对账。Hub 数据库和 Worker journal 均需持久化、定期备份；损坏 journal 会拒绝启动。当前 Worker journal 包含本地结果正文且无自动清理，需保持目录私有。Artifact 下载注册表仍只在 Worker 内存，重启后的历史文件下载尚未恢复。

`npm run test:long-task` 使用真实 Hub/Worker 进程和 Mock OpenCode，持续 185 秒并在期间重启 Hub，验证原执行身份与单次调用。当前完成的是 Agent 长任务与恢复纵向场景；通用排队、后台任务列表和 External Action 正式接入仍待后续验收。
