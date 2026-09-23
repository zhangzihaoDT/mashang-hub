# mashang-hub V0.2

Cloud control plane plus local execution worker. Hub does not access the local dataset or OpenCode directly. Worker is the only component that connects to `127.0.0.1:4096` and reads `mashang-service`.

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

The Hub stores lightweight in-memory Hub Session, task and Artifact metadata. Worker maps Hub Session IDs to OpenCode Session IDs. OpenCode IDs are not treated as browser IDs.

## Local Run

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
HUB_URL=ws://127.0.0.1:3000 WORKER_SECRET=local-worker-secret npm run worker
```

Open <http://localhost:3000>. For user authentication, also set `HUB_ACCESS_TOKEN`; the UI will show a login page. Without it, local development has no user login gate.

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
MASHANG_SERVICE_ROOT=/Users/zihao_/Documents/github/mashang-service
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
TASK_TIMEOUT_MS=180000        # soft timeout
TASK_CANCEL_GRACE_MS=10000    # grace before hard timeout
```

- Soft timeout: broadcasts `task.timeout.warning`, shows "运行超时，正在尝试取消", and sends `task.cancel` to the Worker.
- Hard timeout: forces terminal `task.timeout` with reason `WORKER_REQUEST_TIMEOUT`.
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

Hub to Worker messages include `task.create`, `task.cancel`, `artifact.request`, and `permission.reply`. Worker to Hub messages include `worker.register`, `worker.heartbeat`, `worker.status`, `task.accepted`, `task.running`, `opencode.request.sent`, `opencode.progress`, `opencode.response.received`, `opencode.request.aborted`, `task.completed`, `task.cancelled`, `task.failed`, `task.interrupted`, `agent.message.completed`, `artifact.created`, `permission.requested`, and `session.mapped`.

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
  }
}
```

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
docker build -t mashang-hub:0.2 .
docker run --rm -p 3000:3000 \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e HUB_ACCESS_TOKEN=<private-user-token> \
  -e WORKER_SECRET=<private-worker-secret> \
  mashang-hub:0.2
```

Configure Sealos ingress for HTTPS and use the resulting `https://` URL as the Worker `HUB_URL`. The actual Sealos deployment and phone-over-cellular test are not performed by this repository change.

## Known Limitations

- Hub and Worker state are currently in memory; restart recovery of task state is limited.
- Session mappings are held by the Worker process and are not yet persisted to SQLite.
- One active Worker is supported; there is no scheduling or multi-worker routing.
- Artifact payloads are base64 encoded in the WebSocket response and capped at 20 MB on the Worker.
- Full browser/mobile and Sealos deployment acceptance still require manual environment testing.
