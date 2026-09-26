import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { hasResult } from "./server/result-contract.mjs";
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

function json(res, status, data, headers = {}) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers }); res.end(JSON.stringify(data)); }
async function body(req) { let value = ""; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {}; }
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => part.trim().split("="))); }
function authenticated(req) { if (!accessToken) return true; const cookie = parseCookies(req).hub_session; return Boolean(cookie && authSessions.has(cookie)); }
function requireAuth(req, res) { if (authenticated(req)) return true; json(res, 401, { error: "Authentication required" }); return false; }
function broadcast(event) { const payload = `event: mashang\ndata: ${JSON.stringify(event)}\n\n`; for (const client of browserEvents) { try { client.write(payload); } catch { browserEvents.delete(client); } } }
function sendWorker(message) { if (!activeWorker || activeWorker.readyState !== 1) return false; try { activeWorker.send(JSON.stringify(message)); return true; } catch { return false; } }
function workerStatus(status, extra = {}) { broadcast({ type: "worker.status", status, workerId: activeWorker?.workerId || extra.workerId, ...extra }); }

function modelString(model) { return model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : "unknown"; }
function publicTask(task) { return { taskId: task.taskId, sessionId: task.sessionId, conversationId: task.conversationId, turnId: task.turnId, model: task.model, status: task.status, createdAt: task.createdAt }; }
function clearTaskTimers(task) { clearTimeout(task.timers.soft); clearTimeout(task.timers.hard); clearTimeout(task.timers.cancel); task.timers.soft = task.timers.hard = task.timers.cancel = null; }

function finalizeTask(task, { event, status, reason, error }) {
  if (isTerminal(task.status)) return false;
  task.status = status;
  task.updatedAt = Date.now();
  clearTaskTimers(task);
  const elapsedMs = task.updatedAt - task.createdAt;
  finalizeTurn(task.taskId, { event, status, reason, elapsedMs });
  broadcast({ type: event, taskId: task.taskId, sessionId: task.sessionId, conversationId: task.conversationId, turnId: task.turnId, status, reason: reason || null, error: error || null, elapsedMs });
  if (event === "task.completed") console.log(`task completed: ${task.taskId}`);
  else if (event === "task.timeout") console.log(`task timeout: ${task.taskId} elapsed=${elapsedMs}`);
  else if (event === "task.cancelled") console.log(`task cancelled: ${task.taskId} reason=${reason}`);
  else console.log(`task settled: ${task.taskId} ${status} reason=${reason || "none"}`);
  return true;
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
      task.status = message.type === "task.accepted" ? "SUBMITTING" : "RUNNING";
      task.updatedAt = Date.now();
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
    if (task) finalizeTask(task, { event: "task.failed", status: "FAILED", reason: REASONS.OPENCODE_ERROR, error: message.error });
    else broadcast(message);
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
  return session;
}

async function serveStatic(res, pathname) {
  const file = pathname === "/" ? join(publicDir, "index.html") : join(publicDir, pathname);
  if (!file.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try { const data = await readFile(file); const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }; res.writeHead(200, { "content-type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" }); res.end(data); } catch { json(res, 404, { error: "Not found" }); }
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
  if (url.pathname === "/api/models") return json(res, 200, { models: activeWorker?.models || [] });
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
    session.turnCount = (session.turnCount || 0) + 1;
    const turnId = `turn_${String(session.turnCount).padStart(3, "0")}`;
    const task = { taskId: `task_${randomUUID()}`, sessionId: session.id, conversationId: session.id, turnId, model: modelString(input.model), status: "SUBMITTING", hasText: false, artifactCount: 0, lastProgress: null, pendingCompletion: false, attemptCompletion: null, timers: {}, createdAt: Date.now() };
    tasks.set(task.taskId, task);
    session.workerId = activeWorker.workerId;
    createTurn({ conversationId: session.id, turnId, taskId: task.taskId, model: task.model });
    scheduleWatchdog(task);
    console.log(`task created: ${task.taskId} conversation=${session.id} turn=${turnId}`);
    const dispatched = sendWorker({ type: "task.create", taskId: task.taskId, sessionId: session.id, turnId, prompt: input.parts?.find((part) => part.type === "text")?.text || "", model: input.model });
    if (!dispatched) { console.log(`task dispatch failed: ${task.taskId} session=${session.id}`); finalizeTask(task, { event: "task.failed", status: "FAILED", reason: REASONS.OPENCODE_ERROR, error: "Mac Worker is offline" }); return json(res, 503, { error: "Mac Worker is offline", taskId: task.taskId }); }
    console.log(`task dispatched to worker: ${task.taskId} session=${session.id} worker=${activeWorker.workerId}`);
    return json(res, 202, publicTask(task));
  }
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
    workerStatus("OFFLINE");
  });
  ws.on("error", () => ws.close());
});
setInterval(() => { for (const [id, worker] of workers) if (Date.now() - worker.lastHeartbeat > 35000) { worker.status = "OFFLINE"; if (activeWorker?.workerId === id) workerStatus("OFFLINE", { workerId: id }); } }, 10000);
server.listen(port, host, () => console.log(`mashang-hub control plane listening at http://${host}:${port}`));
