import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { WebSocket } from "ws";
import { isAllowedArtifactPath } from "./artifact-policy.mjs";
import { timeoutConfig } from "../server/task-timeout.mjs";

const hubURL = process.env.HUB_URL;
const workerSecret = process.env.WORKER_SECRET;
const workerId = process.env.WORKER_ID || "zihao-mac";
const opencodeURL = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const projectRoot = process.env.MASHANG_SERVICE_ROOT || "/Users/zihao_/Documents/github/mashang-service";
const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS || 10000);
const stateFile = process.env.WORKER_STATE_FILE || `${homedir()}/.mashang-hub/worker-state.json`;
const artifactOutputRoots = ["outputs", "mashang_workspace/outputs"];
const mappings = new Map();
const localArtifacts = new Map();
const activeTasks = new Map();
const sessionToTask = new Map();
const progressSeen = new Map();
let socket;
let eventReader;
let busy = 0;

if (!hubURL || !workerSecret) { console.error("HUB_URL and WORKER_SECRET are required"); process.exit(1); }

const { requestMs, graceMs } = timeoutConfig();
const safetyAbortMs = requestMs + graceMs;

async function loadMappings() { try { const data = JSON.parse(await readFile(stateFile, "utf8")); for (const [hubSessionId, openCodeSessionId] of Object.entries(data.mappings || {})) mappings.set(hubSessionId, openCodeSessionId); } catch { /* First run has no mapping file. */ } }
async function saveMappings() { try { await mkdir(dirname(stateFile), { recursive: true }); } catch { /* Parent may already exist. */ } try { await writeFile(stateFile, JSON.stringify({ mappings: Object.fromEntries(mappings) }, null, 2), "utf8"); } catch { /* Mapping persistence is best effort. */ } }

async function openCode(path, options = {}) {
  const url = new URL(path, opencodeURL);
  if (!url.searchParams.has("directory")) url.searchParams.set("directory", projectRoot);
  return fetch(url, { ...options, headers: { "content-type": "application/json", "x-opencode-directory": projectRoot, ...(options.headers || {}) } });
}
async function openCodeJSON(path, options = {}) { const response = await openCode(path, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `OpenCode HTTP ${response.status}`); return data; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function heartbeat() { send({ type: "worker.heartbeat", workerId, timestamp: new Date().toISOString(), status: busy ? "BUSY" : "ONLINE" }); }
function modelList(data) {
  const all = Object.values(data.providers || {}).flatMap((provider) => Object.values(provider.models || {}).map((model) => ({ ...model, providerID: model.providerID || provider.id })));
  const pick = (matcher, providerID) => all.filter((model) => model.providerID === providerID && matcher(model.name || "") && model.status !== "disabled")[0];
  const deepseek = pick((name) => /deepseek/i.test(name) && /flash/i.test(name) && /4\.1/.test(name), "deepseek");
  const luna = pick((name) => name === "GPT-5.6 Luna", "opencode-go");
  return [
    { key: "deepseek", label: "DeepSeek Flash 4.1", available: Boolean(deepseek), providerID: deepseek?.providerID, modelID: deepseek?.id, actualName: deepseek?.name },
    { key: "luna", label: "GPT-5.6 Luna", available: Boolean(luna), providerID: luna?.providerID, modelID: luna?.id, actualName: luna?.name },
  ];
}
async function resolveLocalArtifact(path) {
  if (!path || path.includes("\\") || path.split("/").some((part) => part === "..")) return null;
  const root = await realpath(projectRoot); const candidate = path.startsWith("/") ? resolve(path) : resolve(root, path); const candidatePath = relative(root, candidate);
  if (!candidatePath || candidatePath.startsWith("..") || candidatePath.startsWith("/")) return null;
  const canonical = await realpath(candidate); const canonicalPath = relative(root, canonical);
  if (!canonicalPath || canonicalPath.startsWith("..") || canonicalPath.startsWith("/")) return null;
  if (!isAllowedArtifactPath(canonicalPath, artifactOutputRoots)) return null;
  const extension = extname(canonical).toLowerCase(); const names = { ".md": ["Markdown", "text/markdown"], ".html": ["HTML", "text/html"], ".csv": ["CSV", "text/csv"], ".png": ["PNG", "image/png"] };
  if (!names[extension]) return null; const details = await stat(canonical); if (!details.isFile() || details.size > 20 * 1024 * 1024) return null;
  return { file: canonical, path: canonicalPath, name: basename(canonical), extension, type: names[extension][0], mimeType: names[extension][1], size: details.size };
}
async function detectArtifacts(text, taskId) {
  const pattern = /(?:^|[\s"'`(：:])([^\s"'`<>(),;]+\.(?:md|html|csv|png))(?=$|[\s"'`<>(),;])/giu;
  for (const match of text.matchAll(pattern)) {
    const artifact = await resolveLocalArtifact(match[1]); if (!artifact) { console.log("artifact candidate rejected"); continue; }
    console.log("artifact candidate accepted");
    const artifactId = `artifact_${randomUUID()}`; localArtifacts.set(artifactId, artifact);
    send({ type: "artifact.created", artifactId, taskId, name: artifact.name, extension: artifact.extension, mimeType: artifact.mimeType, artifactType: artifact.type, size: artifact.size, path: artifact.path });
  }
}
async function handleArtifactRequest(message) {
  const artifact = localArtifacts.get(message.artifactId); if (!artifact) return send({ type: "artifact.response", requestId: message.requestId, error: "Artifact not found" });
  try { const data = await readFile(artifact.file); send({ type: "artifact.response", requestId: message.requestId, artifactId: message.artifactId, filename: artifact.name, contentType: `${artifact.mimeType}; charset=utf-8`.replace("image/png; charset=utf-8", "image/png"), contentBase64: data.toString("base64") }); }
  catch (error) { send({ type: "artifact.response", requestId: message.requestId, error: error.message }); }
}
function eventType(event) { return event?.type || event?.event || "unknown"; }
function cancelTask(message) {
  const record = activeTasks.get(message.taskId);
  if (!record) return;
  record.source = message.source || "timeout";
  record.controller.abort();
}
async function listenOpenCodeEvents() {
  try {
    const response = await openCode("/event", { headers: { accept: "text/event-stream" } }); if (!response.ok || !response.body) throw new Error(`event HTTP ${response.status}`);
    console.log("opencode connected"); send({ type: "worker.status", workerId, status: "ONLINE", opencode: "CONNECTED" });
    eventReader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) { const { done, value } = await eventReader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const records = buffer.split("\n\n"); buffer = records.pop() || ""; for (const record of records) { const data = record.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim(); if (!data) continue; try { const event = JSON.parse(data); const type = eventType(event); if (type.includes("permission")) send({ type: "permission.requested", requestId: event.properties?.id || event.properties?.permissionID, request: event.properties }); else if (type === "session.status" && event.properties?.status?.type === "busy") { const openCodeSessionId = event.properties.sessionID; const taskId = sessionToTask.get(openCodeSessionId); if (taskId && progressSeen.get(taskId) !== "busy") { progressSeen.set(taskId, "busy"); send({ type: "opencode.progress", taskId, openCodeSessionId, value: "busy" }); } } } catch { /* Unknown OpenCode events are intentionally ignored. */ } } }
  } catch { send({ type: "worker.status", workerId, status: "ERROR", opencode: "DISCONNECTED" }); setTimeout(listenOpenCodeEvents, 3000); }
}
async function handleTask(task) {
  console.log(`task received: ${task.taskId}`);
  const controller = new AbortController();
  const record = { controller, openCodeSessionId: null, source: null };
  activeTasks.set(task.taskId, record);
  const safety = setTimeout(() => { record.source = record.source || "timeout"; controller.abort(); }, safetyAbortMs);
  busy += 1;
  send({ type: "task.accepted", taskId: task.taskId, sessionId: task.sessionId }); console.log(`task accepted: ${task.taskId}`);
  send({ type: "task.running", taskId: task.taskId, sessionId: task.sessionId });
  try {
    let openCodeSessionId = mappings.get(task.sessionId);
    if (!openCodeSessionId) { const session = await openCodeJSON("/session", { method: "POST", body: JSON.stringify({ title: "mashang-hub" }) }); openCodeSessionId = session.id; mappings.set(task.sessionId, openCodeSessionId); await saveMappings(); }
    send({ type: "session.mapped", sessionId: task.sessionId, taskId: task.taskId, openCodeSessionId });
    record.openCodeSessionId = openCodeSessionId;
    sessionToTask.set(openCodeSessionId, task.taskId);
    send({ type: "opencode.request.sent", taskId: task.taskId, sessionId: task.sessionId, openCodeSessionId });
    console.log(`opencode request started: ${task.taskId}`);
    const response = await openCodeJSON(`/session/${encodeURIComponent(openCodeSessionId)}/message`, { method: "POST", body: JSON.stringify({ model: task.model, parts: [{ type: "text", text: task.prompt }] }), signal: controller.signal });
    sessionToTask.delete(openCodeSessionId);
    send({ type: "opencode.response.received", taskId: task.taskId, sessionId: task.sessionId, openCodeSessionId });
    const text = (response.parts || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
    await detectArtifacts(text, task.taskId);
    send({ type: "agent.message.completed", taskId: task.taskId, sessionId: task.sessionId, text, actualModel: { providerID: response.info?.providerID, modelID: response.info?.modelID, cost: response.info?.cost, tokens: response.info?.tokens } });
    send({ type: "task.completed", taskId: task.taskId, sessionId: task.sessionId }); console.log(`task completed: ${task.taskId}`);
  } catch (error) {
    sessionToTask.delete(record.openCodeSessionId);
    if (controller.signal.aborted) {
      const source = record.source || "timeout";
      send({ type: "opencode.request.aborted", taskId: task.taskId, sessionId: task.sessionId, source });
      send({ type: "task.cancelled", taskId: task.taskId, sessionId: task.sessionId, source });
      console.log(`task cancelled: ${task.taskId} source=${source}`);
    } else {
      send({ type: "task.failed", taskId: task.taskId, sessionId: task.sessionId, error: error.message });
      console.log(`task failed: ${task.taskId}`);
    }
  } finally {
    clearTimeout(safety);
    activeTasks.delete(task.taskId);
    progressSeen.delete(task.taskId);
    busy = Math.max(0, busy - 1);
  }
}
async function register() {
  let models = []; let status = "ONLINE";
  try { models = modelList(await openCodeJSON("/config/providers")); } catch (error) { status = "ERROR"; send({ type: "worker.status", workerId, status, error: error.message }); }
  send({ type: "worker.register", workerId, status, models }); listenOpenCodeEvents();
}
function connect() {
  const url = new URL(hubURL); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/worker";
  socket = new WebSocket(url, { headers: { Authorization: `Bearer ${workerSecret}` } });
  socket.on("open", register); socket.on("message", (data) => { try { const message = JSON.parse(data.toString()); if (message.type === "task.create") handleTask(message); else if (message.type === "task.cancel") cancelTask(message); else if (message.type === "artifact.request") handleArtifactRequest(message); else if (message.type === "permission.reply") openCode(`/permission/${encodeURIComponent(message.requestId)}/reply`, { method: "POST", body: JSON.stringify({ response: message.response }) }).catch(() => {}); } catch { /* Keep worker alive on malformed control messages. */ } });
  socket.on("close", () => setTimeout(connect, 2000)); socket.on("error", () => socket.close());
}
await loadMappings(); setInterval(heartbeat, heartbeatMs); connect();
