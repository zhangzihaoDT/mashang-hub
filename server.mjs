import { TaskStore } from "./server/task-store.mjs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { hasResult } from "./server/result-contract.mjs";
import { sanitizeRuntimeSnapshot } from "./server/runtime-contract.mjs";
import { isValidControlOp, isTerminalControl, controlTimeoutConfig, sanitizeControlResult } from "./server/runtime-control.mjs";
import { createTurn, appendEvent, updateTurn, finalizeTurn, getTurn } from "./server/task-log.mjs";
import { timeoutConfig, isTerminal, REASONS } from "./server/task-timeout.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const host = process.env.HUB_HOST || process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const accessToken = process.env.HUB_ACCESS_TOKEN || "";
const workerSecret = process.env.WORKER_SECRET || "";
const workers = new Map();
const sessions = new Map();
const tasks = new Map();
const artifacts = new Map();
const pendingArtifacts = new Map();
const browserEvents = new Set();
const authSessions = new Set();
let activeWorker = null;
let runtimeSnapshot = null;
let runtimeReceivedAt = null;
let runtimeSnapshotSequence = 0;
const controls = new Map();
const taskStore = new TaskStore(process.env.HUB_TASK_DB || join(root, '.local/tasks.sqlite'));
taskStore.recover();
for (const session of taskStore.sessions()) sessions.set(session.id, session);
for (const record of taskStore.list()) {
  if (record.source === 'conversation') tasks.set(record.taskId, { ...record, sessionId: record.conversationId, status: record.legacyStatus || record.status, timers: {}, pendingCompletion: false });
  else if (record.source === 'runtime') controls.set(record.taskId, { ...record, controlId: record.taskId, status: record.legacyStatus || record.status, timeoutMs: record.policy?.executionDeadlineMs, timers: {} });
}
function persistTask(task) {
  const old = taskStore.get(task.taskId);
  const status = ({ SUBMITTING: old?.status === 'RUNNING' ? 'RUNNING' : 'DISPATCHED', TIMEOUT: 'FAILED' })[task.status] || task.status;
  return taskStore.save({ ...old, ...task, status, legacyStatus: task.status, finishedAt: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(task.status) ? Date.now() : null });
}
function persistControl(control) {
  const old = taskStore.get(control.controlId);
  const status = ({ AWAITING_PERMISSION: 'AWAITING_APPROVAL', REJECTED: 'CANCELLED', REFUSED: 'FAILED', TIMEOUT: 'FAILED' })[control.status] || control.status;
  return taskStore.save({ ...old, ...control, taskId: control.controlId, status, legacyStatus: control.status, finishedAt: isTerminalControl(control.status) ? Date.now() : null });
}

function json(res, status, data, headers = {}) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); res.end(JSON.stringify(data)); }
async function body(req) { let value = ""; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {}; }
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => part.trim().split("="))); }
function authenticated(req) { if (!accessToken) return true; const cookie = parseCookies(req).hub_session; return Boolean(cookie && authSessions.has(cookie)); }
function requireAuth(req, res) { if (authenticated(req)) return true; json(res, 401, { error: "Authentication required" }); return false; }
function broadcast(event) { const payload = `event: mashang\ndata: ${JSON.stringify(event)}\n\n`; for (const client of browserEvents) { try { client.write(payload); } catch { browserEvents.delete(client); } } }
function sendWorker(message) { if (!activeWorker || activeWorker.readyState !== 1) return false; try { activeWorker.send(JSON.stringify(message)); return true; } catch { return false; } }
function workerStatus(status, extra = {}) { broadcast({ type: "worker.status", status, workerId: activeWorker?.workerId || extra.workerId, ...extra }); }

function modelString(model) { return model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : "unknown"; }
function publicTask(task) { return { taskId: task.taskId, sessionId: task.sessionId, conversationId: task.conversationId, turnId: task.turnId, model: task.model, workspaceId: task.workspaceId || null, status: task.status, createdAt: task.createdAt }; }

// Workspace ids are opaque to the Hub. It only enforces shape/size and forwards
// them; the Worker decides what each id maps to locally.
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function sanitizeWorkspaceId(value) { const id = String(value).trim(); return WORKSPACE_ID_PATTERN.test(id) ? id : null; }
function sanitizeWorkspaces(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.id === "string" && WORKSPACE_ID_PATTERN.test(item.id))
    .slice(0, 32)
    .map((item) => ({ id: item.id, label: typeof item.label === "string" && item.label ? item.label.slice(0, 80) : item.id }));
}
function clearTaskTimers(task) { clearTimeout(task.timers.soft); clearTimeout(task.timers.hard); clearTimeout(task.timers.cancel); task.timers.soft = task.timers.hard = task.timers.cancel = null; }

function finalizeTask(task, { event, status, reason, error }) {
  if (isTerminal(task.status)) return false;
  if (task.externalEffectPossible && ["FAILED", "TIMEOUT", "CANCELLED", "INTERRUPTED"].includes(status)) error = "外部操作结果可能不确定，请人工核对；不要自动重试。";
  task.status = status;
  task.updatedAt = Date.now();
  clearTaskTimers(task);
  task.reason = reason || null;
  persistTask(task);
  const elapsedMs = task.updatedAt - task.createdAt;
  finalizeTurn(task.taskId, { event, status, reason, elapsedMs });
  broadcast({ type: event, taskId: task.taskId, sessionId: task.sessionId, conversationId: task.conversationId, turnId: task.turnId, status, reason: reason || null, error: error || null, elapsedMs });
  if (event === "task.completed") console.log(`task completed: ${task.taskId}`);
  else if (event === "task.timeout") console.log(`task timeout: ${task.taskId} elapsed=${elapsedMs}`);
  else if (event === "task.cancelled") console.log(`task cancelled: ${task.taskId} reason=${reason}`);
  else console.log(`task settled: ${task.taskId} ${status} reason=${reason || "none"}`);
  return true;
}

function publicControl(control) { return { controlId: control.controlId, op: control.op, targetId: control.targetId, status: control.status, reason: control.reason, code: control.code, createdAt: control.createdAt, updatedAt: control.updatedAt }; }
function broadcastControl(control) { broadcast({ type: "runtime.control.updated", controlId: control.controlId, op: control.op, targetId: control.targetId, status: control.status, reason: control.reason, code: control.code }); }
function clearControlTimers(control) { clearTimeout(control.timers.soft); clearTimeout(control.timers.hard); clearTimeout(control.timers.cancel); control.timers.soft = control.timers.hard = control.timers.cancel = null; }
function finalizeControl(control, status, reason, code = null) {
  if (isTerminalControl(control.status)) return false;
  control.status = status;
  control.reason = reason || null;
  control.code = code;
  control.updatedAt = Date.now();
  clearControlTimers(control);
  persistControl(control);
  broadcastControl(control);
  console.log(`control settled: ${control.controlId} ${status} reason=${reason || "none"}`);
  return true;
}
function scheduleControlWatchdog(control) {
  const config = controlTimeoutConfig(process.env, control.timeoutMs);
  control.timers.soft = setTimeout(() => onControlSoftTimeout(control), config.requestMs);
}
function onControlSoftTimeout(control) {
  if (isTerminalControl(control.status)) return;
  console.log(`control timeout warning: ${control.controlId}`);
  sendWorker({ type: "runtime.control.cancel", controlId: control.controlId, source: "timeout" });
  control.timers.hard = setTimeout(() => { if (!isTerminalControl(control.status)) finalizeControl(control, "TIMEOUT", "CONTROL_TIMEOUT"); }, control.graceTimeoutMs ?? controlTimeoutConfig().graceMs);
}

function scheduleWatchdog(task) {
  const config = timeoutConfig();
  task.softDeadline = task.createdAt + config.requestMs;
  task.hardDeadline = task.createdAt + config.requestMs + config.graceMs;
  task.timers.soft = setTimeout(() => onSoftTimeout(task), config.requestMs);
}

function onSoftTimeout(task) {
  if (isTerminal(task.status)) return;
  const elapsedMs = Date.now() - task.createdAt;
  appendEvent(task.taskId, { event: "task.timeout.warning", reason: REASONS.WORKER_REQUEST_TIMEOUT, elapsedMs });
  broadcast({ type: "task.timeout.warning", taskId: task.taskId, sessionId: task.sessionId, conversationId: task.conversationId, turnId: task.turnId, reason: REASONS.WORKER_REQUEST_TIMEOUT, elapsedMs });
  console.log(`task timeout warning: ${task.taskId} elapsed=${elapsedMs}`);
  sendWorker({ type: "task.cancel", taskId: task.taskId, source: "timeout" });
  task.timers.hard = setTimeout(() => onHardTimeout(task), Math.max(0, task.hardDeadline - Date.now()));
}

function onHardTimeout(task) {
  if (isTerminal(task.status)) return;
  finalizeTask(task, { event: "task.timeout", status: "TIMEOUT", reason: REASONS.WORKER_REQUEST_TIMEOUT });
}

function workerModelsMessage(message) {
  if (message.type !== "worker.register") return;
  const worker = { ...message, status: message.status || "ONLINE", connectedAt: new Date().toISOString(), lastHeartbeat: Date.now() };
  workers.set(message.workerId, worker);
  activeWorker.workerId = message.workerId;
  activeWorker.models = message.models || [];
  activeWorker.workspaces = sanitizeWorkspaces(message.workspaces);
  runtimeSnapshotSequence = 0;
  console.log(`worker connected: ${message.workerId}`);
  workerStatus(worker.status, { workerId: message.workerId, models: activeWorker.models });
  sendWorker({ type: "worker.registered", workerId: message.workerId });
}

function onWorkerMessage(message) {
  if (message.type === "worker.register") return workerModelsMessage(message);
  if (message.type === "worker.heartbeat") {
    const worker = workers.get(message.workerId);
    if (worker) Object.assign(worker, { status: message.status || "ONLINE", lastHeartbeat: Date.now() });
    workerStatus(message.status || "ONLINE", { workerId: message.workerId });
    return;
  }
  if (message.type === "artifact.created") {
    artifacts.set(message.artifactId, message);
    const task = tasks.get(message.taskId);
    if (task) {
      task.artifactCount += 1;
      if (!isTerminal(task.status)) appendEvent(task.taskId, { event: "artifact.created", value: message.artifactId });
      if (task.pendingCompletion && task.attemptCompletion) task.attemptCompletion();
    }
    console.log(`artifact created: ${message.artifactId} task=${message.taskId}`);
    broadcast(message);
    return;
  }
  if (message.type === "artifact.response") {
    const pending = pendingArtifacts.get(message.requestId);
    if (pending) { pendingArtifacts.delete(message.requestId); pending.resolve(message); }
    return;
  }
  if (message.type === "runtime.snapshot") {
    const snapshot = sanitizeRuntimeSnapshot(message);
    if (!snapshot || (snapshot.sequence !== null && snapshot.sequence <= runtimeSnapshotSequence)) return;
    runtimeSnapshotSequence = snapshot.sequence ?? runtimeSnapshotSequence;
    runtimeSnapshot = snapshot;
    runtimeReceivedAt = new Date().toISOString();
    broadcast({ type: "runtime.snapshot", workerOnline: Boolean(activeWorker), receivedAt: runtimeReceivedAt, snapshot });
    return;
  }
  if (message.type === "runtime.control.result") {
    const control = controls.get(message.controlId);
    if (!control) return;
    const { status, reason, code } = sanitizeControlResult(message);
    finalizeControl(control, status, reason, code);
    return;
  }
  if (message.type === "worker.status") { workerStatus(message.status, message); return; }
  if (message.type === "session.mapped") {
    const session = sessions.get(message.sessionId);
    if (session) Object.assign(session, { workerId: activeWorker?.workerId, openCodeSessionId: message.openCodeSessionId });
    const task = tasks.get(message.taskId);
    if (task) updateTurn(task.taskId, { openCodeSessionId: message.openCodeSessionId });
    broadcast(message);
    return;
  }
  if (message.type === "opencode.request.sent" || message.type === "opencode.response.received" || message.type === "opencode.request.aborted") {
    const task = tasks.get(message.taskId);
    if (task && !isTerminal(task.status)) appendEvent(task.taskId, { event: message.type });
    broadcast(message);
    return;
  }
  if (message.type === "opencode.progress") {
    const task = tasks.get(message.taskId);
    if (task && !isTerminal(task.status) && task.lastProgress !== message.value) {
      task.lastProgress = message.value;
      appendEvent(task.taskId, { event: "opencode.progress", value: message.value });
    }
    broadcast(message);
    return;
  }
  if (message.type === "agent.message.completed") {
    const task = tasks.get(message.taskId);
    if (task && !isTerminal(task.status)) {
      task.hasText = Boolean(message.text?.trim());
      appendEvent(task.taskId, { event: "agent.message.completed" });
    }
    broadcast(message);
    return;
  }
  if (message.type === "task.accepted" || message.type === "task.running") {
    const task = tasks.get(message.taskId);
    if (task && !isTerminal(task.status)) {
      if (message.externalEffectPossible === true) task.externalEffectPossible = true;
      task.status = message.type === "task.accepted" ? "SUBMITTING" : "RUNNING";
      task.updatedAt = Date.now();
      if (task.status === "RUNNING") task.startedAt ||= Date.now();
      persistTask(task);
      updateTurn(task.taskId, { status: task.status });
    }
    broadcast(message);
    return;
  }
  if (message.type === "task.completed") {
    const task = tasks.get(message.taskId);
    if (!task) { broadcast(message); return; }
    task.pendingCompletion = true;
    task.attemptCompletion = () => {
      if (!task.pendingCompletion || isTerminal(task.status)) return;
      task.pendingCompletion = false;
      if (hasResult(task)) finalizeTask(task, { event: "task.completed", status: "COMPLETED" });
      else finalizeTask(task, { event: "task.failed", status: "FAILED", reason: REASONS.EMPTY_RESULT, error: "Agent completed without text or artifact" });
    };
    if (hasResult(task)) task.attemptCompletion();
    else setTimeout(task.attemptCompletion, 1000);
    return;
  }
  if (message.type === "task.cancelled") {
    const task = tasks.get(message.taskId);
    if (!task) { broadcast(message); return; }
    if (message.source === "user") finalizeTask(task, { event: "task.cancelled", status: "CANCELLED", reason: REASONS.USER_CANCELLED });
    else finalizeTask(task, { event: "task.timeout", status: "TIMEOUT", reason: REASONS.WORKER_REQUEST_TIMEOUT });
    return;
  }
  if (message.type === "task.failed") {
    const task = tasks.get(message.taskId);
    if (task) {
      const reason = typeof message.reason === "string" && REASONS[message.reason] ? message.reason : REASONS.OPENCODE_ERROR;
      finalizeTask(task, { event: "task.failed", status: "FAILED", reason, error: message.error });
    } else broadcast(message);
    return;
  }
  if (message.type === "task.interrupted") {
    const task = tasks.get(message.taskId);
    if (task) finalizeTask(task, { event: "task.interrupted", status: "INTERRUPTED", reason: REASONS.WORKER_DISCONNECTED });
    else broadcast(message);
    return;
  }
  broadcast(message);
}

function createHubSession(title = "mashang-hub") {
  const session = { id: `hub_${randomUUID()}`, title, workerId: null, openCodeSessionId: null, turnCount: 0, createdAt: new Date().toISOString() };
  sessions.set(session.id, session);
  taskStore.saveSession(session);
  return session;
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? join(publicDir, "index.html") : join(publicDir, pathname);
  if (!file.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try { const data = await readFile(file); const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" }; const type = types[extname(file)] || "application/octet-stream"; const contentType = type.startsWith("text/") || type === "image/svg+xml" ? `${type}; charset=utf-8` : type; res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }); res.end(data); } catch { json(res, 404, { error: "Not found" }); }
}

async function requestArtifact(req, res, download) {
  const artifactId = new URL(req.url, "http://localhost").searchParams.get("artifactId");
  const artifact = artifacts.get(artifactId);
  if (!artifact) return json(res, 404, { error: "Artifact not found" });
  const requestId = randomUUID();
  const result = new Promise((resolve, reject) => { const timer = setTimeout(() => { pendingArtifacts.delete(requestId); reject(new Error("Worker artifact request timed out")); }, 30000); pendingArtifacts.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject }); });
  console.log(`artifact requested: ${artifactId}`);
  if (!sendWorker({ type: "artifact.request", requestId, artifactId, mode: download ? "download" : "content" })) return json(res, 503, { error: "Mac Worker is offline" });
  try {
    const response = await result;
    if (response.error) return json(res, 404, { error: response.error });
    const headers = { "content-type": response.contentType, "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(response.filename)}`, "x-content-type-options": "nosniff" };
    if (!download && artifact.extension === ".html") headers["content-security-policy"] = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    res.writeHead(200, headers); res.end(Buffer.from(response.contentBase64, "base64"));
  } catch (error) { json(res, 504, { error: error.message }); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/api/auth/status") return json(res, 200, { required: Boolean(accessToken), authenticated: authenticated(req) });
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const input = await body(req);
    if (!accessToken || input.token !== accessToken) return json(res, 401, { error: "Invalid access token" });
    const session = randomUUID(); authSessions.add(session);
    const secure = process.env.NODE_ENV === "production" || req.headers["x-forwarded-proto"] === "https";
    return json(res, 200, { authenticated: true }, { "set-cookie": `hub_session=${session}; HttpOnly; SameSite=Lax; Path=/;${secure ? " Secure;" : ""}` });
  }
  if (url.pathname.startsWith("/api/") && !requireAuth(req, res)) return;
  if (url.pathname === "/api/health") return json(res, 200, { connected: Boolean(activeWorker), worker: activeWorker ? { id: activeWorker.workerId, status: workers.get(activeWorker.workerId)?.status || "CONNECTING" } : null });
  if (url.pathname === "/api/worker") return json(res, 200, { worker: activeWorker ? { id: activeWorker.workerId, status: workers.get(activeWorker.workerId)?.status || "CONNECTING" } : null });
  if (url.pathname === "/api/runtime") return json(res, 200, { workerOnline: Boolean(activeWorker), receivedAt: runtimeReceivedAt, snapshot: runtimeSnapshot });
  if (url.pathname === "/api/runtime/control" && req.method === "POST") {
    const input = await body(req);
    const op = String(input.op || "");
    const targetId = String(input.targetId || "");
    if (!isValidControlOp(op) || !targetId) return json(res, 400, { error: "Invalid op or targetId" });
    const serviceTarget = runtimeSnapshot?.services?.some((service) => service.id === targetId);
    const jobTarget = runtimeSnapshot?.jobs?.some((job) => job.id === targetId);
    const operationTarget = runtimeSnapshot?.operations?.find((operation) => operation.id === targetId);
    const dependencyTarget = runtimeSnapshot?.dependencies?.some((dependency) => dependency.id === targetId);
    const validTarget = !dependencyTarget && (op === "run" ? (jobTarget || Boolean(operationTarget)) : serviceTarget);
    if (!validTarget) return json(res, 404, { error: "Unknown runtime target", reason: "UNKNOWN_TARGET" });
    if (op === "run" && operationTarget && !operationTarget.enabled) return json(res, 409, { error: "Operation is disabled", reason: "OPERATION_DISABLED" });
    if (!activeWorker || activeWorker.readyState !== 1) return json(res, 503, { error: "Mac Worker is offline" });
    const control = {
      controlId: `control_${randomUUID()}`,
      op,
      targetId,
      timeoutMs: operationTarget?.timeoutMs ?? null,
      cancellationSupported: operationTarget?.cancellationSupported !== false,
      graceTimeoutMs: controlTimeoutConfig().graceMs,
      status: "AWAITING_PERMISSION",
      reason: null,
      code: null,
      timers: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    Object.assign(control, { source: 'runtime', executor: 'operation', workerId: activeWorker.workerId, attempt: 0, policy: { requiresApproval: true, retry: 'manual', executionDeadlineMs: controlTimeoutConfig(process.env, control.timeoutMs).requestMs } });
    controls.set(control.controlId, control);
    persistControl(control);
    console.log(`control created: ${control.controlId} op=${op} target=${targetId}`);
    broadcast({ type: "runtime.control.requested", ...publicControl(control) });
    broadcast({ type: "runtime.control.permission.requested", controlId: control.controlId, op, targetId });
    return json(res, 202, publicControl(control));
  }
  if (url.pathname === "/api/runtime/controls" && req.method === "GET") return json(res, 200, [...controls.values()].map(publicControl));
  const controlDecision = url.pathname.match(/^\/api\/runtime\/controls\/([^/]+)\/decision$/);
  if (controlDecision && req.method === "POST") {
    const control = controls.get(controlDecision[1]);
    if (!control) return json(res, 404, { error: "Control not found" });
    if (control.status !== "AWAITING_PERMISSION") return json(res, 409, { error: "Control already decided", status: control.status });
    const approved = Boolean((await body(req)).approve);
    if (!approved) { taskStore.reject(control.controlId, "CANCELLED", "USER_REJECTED"); finalizeControl(control, "REJECTED", "USER_REJECTED"); return json(res, 200, publicControl(control)); }
    const dispatch = taskStore.dispatch(control.controlId, { legacyStatus: "RUNNING", startedAt: Date.now(), workerId: activeWorker?.workerId || control.workerId });
    Object.assign(control, dispatch);
    control.status = "RUNNING";
    control.updatedAt = Date.now();
    const dispatched = sendWorker({ type: "runtime.control.request", controlId: control.controlId, attemptId: control.attemptId, dispatchId: control.dispatchId, op: control.op, targetId: control.targetId });
    broadcastControl(control);
    console.log(`control approved: ${control.controlId} op=${control.op} target=${control.targetId}`);
    if (!dispatched) { finalizeControl(control, "FAILED", "WORKER_OFFLINE"); return json(res, 200, publicControl(control)); }
    scheduleControlWatchdog(control);
    return json(res, 200, publicControl(control));
  }
  const controlCancel = url.pathname.match(/^\/api\/runtime\/controls\/([^/]+)\/cancel$/);
  if (controlCancel && req.method === "POST") {
    const control = controls.get(controlCancel[1]);
    if (!control) return json(res, 404, { error: "Control not found" });
    if (isTerminalControl(control.status)) return json(res, 409, { error: "Control already settled", status: control.status });
    if (control.status === "AWAITING_PERMISSION") { finalizeControl(control, "CANCELLED", "USER_CANCELLED"); return json(res, 202, publicControl(control)); }
    if (!control.cancellationSupported) return json(res, 409, { error: "Operation does not support cancellation", reason: "CANCELLATION_UNSUPPORTED" });
    console.log(`control cancel requested: ${control.controlId}`);
    sendWorker({ type: "runtime.control.cancel", controlId: control.controlId, source: "user" });
    clearTimeout(control.timers.hard);
    control.timers.cancel = setTimeout(() => { if (!isTerminalControl(control.status)) finalizeControl(control, "CANCELLED", "USER_CANCELLED"); }, controlTimeoutConfig().graceMs);
    return json(res, 202, publicControl(control));
  }
  const controlGet = url.pathname.match(/^\/api\/runtime\/controls\/([^/]+)$/);
  if (controlGet && req.method === "GET") { const control = controls.get(controlGet[1]); return control ? json(res, 200, publicControl(control)) : json(res, 404, { error: "Control not found" }); }
  if (url.pathname === "/api/models") return json(res, 200, { models: activeWorker?.models || [] });
  if (url.pathname === "/api/workspaces") return json(res, 200, { workspaces: activeWorker?.workspaces || [] });
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); browserEvents.add(res); res.write(`event: mashang\ndata: ${JSON.stringify({ type: "worker.status", status: activeWorker ? "ONLINE" : "OFFLINE" })}\n\n`); req.on("close", () => browserEvents.delete(res)); return;
  }
  if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, [...sessions.values()]);
  if (url.pathname === "/api/sessions" && req.method === "POST") return json(res, 200, createHubSession((await body(req)).title));
  const turn = url.pathname.match(/^\/api\/turns\/([^/]+)$/);
  if (turn && req.method === "GET") { const record = getTurn(turn[1]); return record ? json(res, 200, record) : json(res, 404, { error: "Turn not found" }); }
  const message = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
  if (message && req.method === "POST") {
    console.log(`task request received: session=${message[1]} worker=${activeWorker?.workerId || "none"}`);
    const session = sessions.get(message[1]);
    if (!session) return json(res, 404, { error: "Hub Session not found" });
    if (!activeWorker || activeWorker.readyState !== 1) return json(res, 503, { error: "Mac Worker is offline" });
    const input = await body(req);
    const rawWorkspace = input.workspaceId;
    const workspaceId = rawWorkspace == null || rawWorkspace === "" ? null : sanitizeWorkspaceId(rawWorkspace);
    if (rawWorkspace != null && rawWorkspace !== "" && workspaceId === null) return json(res, 400, { error: "Invalid workspaceId" });
    session.turnCount = (session.turnCount || 0) + 1;
    const turnId = `turn_${String(session.turnCount).padStart(3, "0")}`;
    const task = { taskId: `task_${randomUUID()}`, sessionId: session.id, conversationId: session.id, turnId, model: modelString(input.model), workspaceId, status: "SUBMITTING", hasText: false, artifactCount: 0, lastProgress: null, pendingCompletion: false, attemptCompletion: null, timers: {}, createdAt: Date.now() };
    Object.assign(task, { source: 'conversation', executor: 'agent', workerId: activeWorker.workerId, attempt: 0, policy: { requiresApproval: false, retry: 'manual', executionDeadlineMs: timeoutConfig().requestMs } });
    taskStore.save({ ...task, status: 'CREATED', legacyStatus: 'SUBMITTING', updatedAt: Date.now() });
    Object.assign(task, taskStore.dispatch(task.taskId, { legacyStatus: 'SUBMITTING' }));
    task.status = 'SUBMITTING';
    tasks.set(task.taskId, task);
    session.workerId = activeWorker.workerId;
    taskStore.saveSession(session);
    createTurn({ conversationId: session.id, turnId, taskId: task.taskId, model: task.model, workspaceId });
    scheduleWatchdog(task);
    console.log(`task created: ${task.taskId} conversation=${session.id} turn=${turnId} workspace=${workspaceId || "default"}`);
    const dispatched = sendWorker({ type: "task.create", taskId: task.taskId, attemptId: task.attemptId, dispatchId: task.dispatchId, sessionId: session.id, turnId, prompt: input.parts?.find((part) => part.type === "text")?.text || "", actor: { kind: "user", authenticated: Boolean(accessToken) && authenticated(req) }, confirmationId: typeof input.confirmationId === "string" && /^[a-f0-9]{64}$/.test(input.confirmationId) ? input.confirmationId : null, model: input.model, workspaceId });
    if (!dispatched) { console.log(`task dispatch failed: ${task.taskId} session=${session.id}`); finalizeTask(task, { event: "task.failed", status: "FAILED", reason: REASONS.OPENCODE_ERROR, error: "Mac Worker is offline" }); return json(res, 503, { error: "Mac Worker is offline", taskId: task.taskId }); }
    console.log(`task dispatched to worker: ${task.taskId} session=${session.id} worker=${activeWorker.workerId}`);
    return json(res, 202, publicTask(task));
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, taskStore.list());
  const taskQuery = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskQuery && req.method === 'GET') { const record = taskStore.get(taskQuery[1]); return record ? json(res, 200, record) : json(res, 404, { error: 'Task not found' }); }
  const cancel = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancel && req.method === "POST") {
    const task = tasks.get(cancel[1]);
    if (!task) return json(res, 404, { error: "Task not found" });
    if (isTerminal(task.status)) return json(res, 409, { error: "Task already settled", status: task.status });
    console.log(`task cancel requested: ${task.taskId}`);
    appendEvent(task.taskId, { event: "task.cancel.requested", source: "user" });
    const dispatched = sendWorker({ type: "task.cancel", taskId: task.taskId, source: "user" });
    if (!dispatched) { finalizeTask(task, { event: "task.cancelled", status: "CANCELLED", reason: REASONS.USER_CANCELLED, error: "Mac Worker is offline" }); return json(res, 202, { ok: true, taskId: task.taskId, immediate: true }); }
    clearTimeout(task.timers.cancel);
    task.timers.cancel = setTimeout(() => { if (!isTerminal(task.status)) finalizeTask(task, { event: "task.cancelled", status: "CANCELLED", reason: REASONS.USER_CANCELLED }); }, timeoutConfig().graceMs);
    return json(res, 202, { ok: true, taskId: task.taskId });
  }
  const artifact = url.pathname.match(/^\/api\/artifacts\/(content|download)$/);
  if (artifact && req.method === "GET") return requestArtifact(req, res, artifact[1] === "download");
  const permission = url.pathname.match(/^\/api\/permissions\/([^/]+)\/reply$/);
  if (permission && req.method === "POST") { sendWorker({ type: "permission.reply", requestId: permission[1], response: (await body(req)).response }); return json(res, 200, { ok: true }); }
  return serveStatic(res, url.pathname);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/worker" || (workerSecret && req.headers.authorization !== `Bearer ${workerSecret}`)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  if (activeWorker) activeWorker.close(4001, "replaced");
  activeWorker = ws; workerStatus("CONNECTING");
  ws.on("message", (data) => { try { onWorkerMessage(JSON.parse(data.toString())); } catch { /* Keep the control plane alive on malformed worker input. */ } });
  ws.on("close", () => {
    if (activeWorker !== ws) return;
    activeWorker = null;
    for (const task of tasks.values()) if (!isTerminal(task.status)) finalizeTask(task, { event: "task.interrupted", status: "INTERRUPTED", reason: REASONS.WORKER_DISCONNECTED, error: "Mac Worker disconnected" });
    for (const control of controls.values()) if (!isTerminalControl(control.status)) finalizeControl(control, "FAILED", "WORKER_DISCONNECTED");
    workerStatus("OFFLINE");
    broadcast({ type: "runtime.snapshot", workerOnline: false, receivedAt: runtimeReceivedAt, snapshot: runtimeSnapshot });
  });
  ws.on("error", () => ws.close());
});
setInterval(() => { for (const [id, worker] of workers) if (Date.now() - worker.lastHeartbeat > 35000) { worker.status = "OFFLINE"; if (activeWorker?.workerId === id) workerStatus("OFFLINE", { workerId: id }); } }, 10000);
server.listen(port, host, () => console.log(`mashang-hub control plane listening at http://${host}:${port}`));
