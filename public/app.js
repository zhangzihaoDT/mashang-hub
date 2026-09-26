import { transitionTaskState } from "./task-state.js";

function $(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`DOM contract missing: ${selector}`);
  return element;
}
function optional(selector) { return document.querySelector(selector); }
const state = { session: null, connected: false, status: "IDLE", workerStatus: "OFFLINE", taskState: "IDLE", activeTaskId: null, turnId: null, openCodeSessionId: null, events: [], lastRequest: null, lastResponse: null, messages: [], assistantText: "", artifactScanText: "", artifacts: [], models: [], selectedModel: null };

const TASK_LABELS = { IDLE: "等待输入", SUBMITTING: "正在提交", UNDERSTANDING: "正在理解请求", PLANNING: "正在规划", RUNNING: "正在分析", RENDERING: "正在整理结果", COMPLETED: "分析完成", FAILED: "执行失败", INTERRUPTED: "执行中断", TIMEOUT: "执行超时", CANCELLED: "已取消", WAITING_PERMISSION: "等待权限", ERROR: "连接错误" };

function escapeHTML(value = "") { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function markdown(value = "") {
  const blocks = [];
  let text = escapeHTML(value).replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${code.trim()}</code></pre>`); return `\x00${blocks.length - 1}\x00`; });
  text = text.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h2>$1</h2>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.split(/\n{2,}/).map((paragraph) => paragraph.startsWith("\x00") ? paragraph : `<p>${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  return text.replace(/\x00(\d+)\x00/g, (_, index) => blocks[index]);
}
function sessionName(session) { return session?.title || session?.name || session?.id?.slice(0, 16) || "未创建"; }
function updateSendAvailability() { $("#send").disabled = !state.connected || !state.selectedModel?.available; }
function setConnection(connected, status = state.workerStatus) { state.connected = connected; state.workerStatus = status; $("#connection").className = `connection ${connected ? "connected" : "disconnected"}`; $("#connection span").textContent = `Mac Worker ${status === "BUSY" ? "Running" : connected ? "Online" : "Offline"}`; updateSendAvailability(); }
function setStatus(status, label) { state.status = status; const el = $("#runState"); el.className = `run-state ${status.toLowerCase()}`; el.querySelector("span:last-child").textContent = label || TASK_LABELS[status] || status; }
function setStatusLabel(label) { const el = optional("#runState"); if (el) el.querySelector("span:last-child").textContent = label; }
function isTerminalState() { return ["COMPLETED", "FAILED", "INTERRUPTED", "TIMEOUT", "CANCELLED"].includes(state.taskState); }
function updateCancelVisibility() { const button = optional("#cancel"); if (!button) return; button.classList.toggle("hidden", !state.activeTaskId || isTerminalState()); }
function applyTaskEvent(taskId, type) {
  const result = transitionTaskState({ taskId: state.activeTaskId, status: state.taskState }, { taskId, type });
  if (result.taskId === state.activeTaskId && result.status === state.taskState) return false;
  state.activeTaskId = result.taskId;
  state.taskState = result.status;
  setStatus(result.status);
  updateCancelVisibility();
  return true;
}
function renderSession() { $("#sessionMeta").textContent = state.session ? `Session: ${sessionName(state.session)}  ·  ${state.selectedModel ? `${state.selectedModel.providerID}/${state.selectedModel.modelID}` : "OpenCode"}` : "未创建 Session"; }
function renderMessages() { const container = $("#messages"); const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80; container.innerHTML = state.messages.length ? state.messages.map((item) => `<div class="message ${item.role}"><div class="label">${item.role === "user" ? "You" : "Assistant"}</div><div class="bubble">${item.role === "user" ? escapeHTML(item.text) : markdown(item.text)}${item.role === "assistant" && item.model ? `<div class="message-meta">${escapeHTML(item.model.label || item.model.modelID || "OpenCode")}</div>` : ""}</div></div>`).join("") : `<div class="welcome"><div class="avatar">🦝</div><h2>今天想先看什么？</h2><p>把问题交给 OpenCode。它会沿用当前 Session，调用本机已有能力。</p></div>`; if (nearBottom) container.scrollTop = container.scrollHeight; }
function renderResult(text) { $("#resultContent").innerHTML = text ? markdown(text) : `<div class="empty-result"><span>◌</span><p>完成一次提问后，结果会显示在这里。</p></div>`; }
function artifactCandidates(text = "") { const pattern = /(?:^|[\s"'`(])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\.(?:md|html|csv|png))(?=$|[\s"'`),.;])/gu; return [...text.matchAll(pattern)].map((match) => match[1]); }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function artifactURL(endpoint, artifactId) { return `${endpoint}?artifactId=${encodeURIComponent(artifactId)}`; }
function ensureArtifactMount() { let box = optional("#artifacts"); if (!box) { box = document.createElement("div"); box.id = "artifacts"; box.className = "artifacts hidden"; $("#resultBody").append(box); } return box; }
function renderArtifacts() {
  let box = optional("#artifacts");
  if (!state.artifacts.length) { if (box) { box.classList.add("hidden"); box.innerHTML = ""; } return; }
  box = box || ensureArtifactMount();
  box.classList.remove("hidden");
  box.innerHTML = `<div class="artifacts-title"><span>Artifacts</span><small>${state.artifacts.length} 个文件</small></div>${state.artifacts.map((artifact, index) => `<div class="artifact-card" data-index="${index}"><div class="artifact-icon artifact-${artifact.extension.slice(1)}">${artifact.extension.slice(1).toUpperCase()}</div><div class="artifact-info"><strong>${escapeHTML(artifact.name)}</strong><span>${escapeHTML(artifact.type || artifact.artifactType)} · ${formatBytes(artifact.size)}</span><small title="${escapeHTML(artifact.path || artifact.name)}">${escapeHTML(artifact.path || "Local artifact")}</small></div><div class="artifact-actions">${artifact.extension === ".csv" ? "" : `<button data-action="preview">Preview</button>`}<a class="artifact-download" href="${artifactURL("/api/artifacts/download", artifact.artifactId)}" download>Download</a></div>${artifact.preview ? `<div class="artifact-preview">${artifact.preview}</div>` : ""}</div>`).join("")}`;
}
async function discoverArtifacts(text) { const candidates = [...new Set(artifactCandidates(text))]; state.artifacts = (await Promise.all(candidates.map(async (path) => { try { const response = await fetch(artifactURL("/api/artifacts/metadata", path)); if (!response.ok) return null; return await response.json(); } catch { return null; } }))).filter(Boolean).map((artifact) => ({ ...artifact, preview: "" })); renderArtifacts(); }
async function previewArtifact(card, artifact) {
  if (artifact.preview) { artifact.preview = ""; renderArtifacts(); return; }
  if (artifact.extension === ".png") artifact.preview = `<img class="artifact-image" src="${artifactURL("/api/artifacts/content", artifact.artifactId)}" alt="${escapeHTML(artifact.name)}">`;
  else if (artifact.extension === ".html") artifact.preview = `<iframe class="artifact-frame" sandbox src="${artifactURL("/api/artifacts/content", artifact.artifactId)}" title="${escapeHTML(artifact.name)}"></iframe>`;
  else if (artifact.extension === ".md") { const response = await fetch(artifactURL("/api/artifacts/content", artifact.artifactId)); artifact.preview = `<div class="artifact-markdown">${markdown(await response.text())}</div>`; }
  renderArtifacts();
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
optional("#artifacts")?.addEventListener("click", (event) => { const button = event.target.closest("[data-action='preview']"); if (!button) return; const card = button.closest(".artifact-card"); previewArtifact(card, state.artifacts[Number(card.dataset.index)]); });
function logEvent(event) { const previous = state.events[state.events.length - 1]; if (event.type === "worker.status" && previous?.type === "worker.status" && previous.workerId === event.workerId && previous.status === event.status) return; state.events.push(event); if (state.events.length > 100) state.events.shift(); renderDebug(); }
function renderDebug() { const panel = optional("#debugContent"); if (!panel) return; const last = state.events[state.events.length - 1]; panel.innerHTML = `<dl><dt>Conversation ID</dt><dd>${escapeHTML(state.session?.id || "-")}</dd><dt>Turn ID</dt><dd>${escapeHTML(state.turnId || "-")}</dd><dt>Task ID</dt><dd>${escapeHTML(state.activeTaskId || "-")}</dd><dt>OpenCode Session</dt><dd>${escapeHTML(state.openCodeSessionId || "-")}</dd><dt>Model</dt><dd>${escapeHTML(state.selectedModel ? `${state.selectedModel.providerID}/${state.selectedModel.modelID}` : "-")}</dd><dt>Status</dt><dd>${state.taskState}</dd><dt>Last Event</dt><dd>${escapeHTML(last?.type || "-")}</dd><dt>Events (${state.events.length})</dt></dl><pre>${escapeHTML(JSON.stringify(state.events.slice(-12), null, 2))}</pre>`; }

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) showLogin();
  state.lastRequest = { path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  state.lastResponse = data; renderDebug();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function showLogin() { optional("#loginOverlay")?.classList.remove("hidden"); }
function hideLogin() { optional("#loginOverlay")?.classList.add("hidden"); }
optional("#loginForm")?.addEventListener("submit", async (event) => { event.preventDefault(); const input = optional("#accessToken"); const error = optional("#loginError"); if (!input || !error) return; try { const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: input.value }) }); if (!response.ok) throw new Error("Invalid access token"); hideLogin(); location.reload(); } catch (loginError) { error.textContent = loginError.message; } });
function modelLabel(model) { return model?.label || model?.actualName || model?.modelID || "Unknown model"; }
function renderModelOptions(models) {
  const select = $("#modelSelect");
  select.innerHTML = models.map((model) => `<option value="${escapeHTML(model.key)}" ${model.available ? "" : "disabled"}>${escapeHTML(model.label)}${model.available ? "" : " unavailable"}</option>`).join("");
  const defaultModel = models.find((model) => model.key === "deepseek");
  if (defaultModel) { select.value = defaultModel.key; state.selectedModel = defaultModel.available ? defaultModel : null; }
  else { select.value = ""; state.selectedModel = null; }
  select.disabled = false;
  renderSession();
  updateSendAvailability();
}
async function loadModels() {
  try { const data = await api("/api/models"); state.models = data.models || []; renderModelOptions(state.models); }
  catch { $("#modelSelect").innerHTML = "<option>Models unavailable</option>"; $("#modelSelect").disabled = true; state.selectedModel = null; updateSendAvailability(); }
}
$("#modelSelect").addEventListener("change", () => { state.selectedModel = state.models.find((model) => model.key === $("#modelSelect").value) || null; renderSession(); updateSendAvailability(); });
async function refreshConnection() { try { await api("/api/health"); setConnection(true); } catch { setConnection(false); setStatus("ERROR", "OpenCode Server 未运行"); $("#resultContent").innerHTML = `<div class="empty-result"><span>!</span><h3>OpenCode Server 未运行</h3><p>请在另一个 Terminal 启动：</p><pre>cd ~/Documents/github/mashang-service\nopencode serve --hostname 127.0.0.1 --port 4096</pre></div>`; } }
async function ensureSession() {
  const sessions = await api("/api/sessions");
  const savedID = localStorage.getItem("mashang-hub-session");
  state.session = sessions.find?.((item) => item.id === savedID);
  if (!state.session) state.session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "mashang-hub" }) });
  localStorage.setItem("mashang-hub-session", state.session.id);
  renderSession(); renderDebug();
}
function parseMessage(data) { return (data?.parts || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n"); }
function actualModel(info) { const modelID = info?.modelID || info?.model?.id; const providerID = info?.providerID || info?.model?.providerID; const known = state.models?.find((model) => model.modelID === modelID && model.providerID === providerID); return { label: known ? modelLabel(known) : modelID ? `${providerID || ""}/${modelID}` : "Unknown model", modelID, providerID, cost: info?.cost, tokens: info?.tokens }; }
async function sendPrompt(text) {
  state.messages.push({ role: "user", text });
  state.assistantText = ""; state.artifactScanText = ""; state.artifacts = [];
  state.activeTaskId = null; state.taskState = "UNDERSTANDING";
  renderMessages(); renderResult(""); renderArtifacts(); setStatus("UNDERSTANDING"); updateCancelVisibility(); $("#send").disabled = true;
  try {
    if (!state.session) await ensureSession();
    if (!state.selectedModel?.available) throw new Error("请选择可用模型");
    const response = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/message`, { method: "POST", body: JSON.stringify({ model: { providerID: state.selectedModel.providerID, modelID: state.selectedModel.modelID }, parts: [{ type: "text", text }] }) });
    if (response.taskId) { if (response.turnId) state.turnId = response.turnId; applyTaskEvent(response.taskId, "task.accepted"); }
    renderDebug();
    const answer = parseMessage(response) || response?.text || response?.message?.text;
    if (answer) completeAssistant(answer, actualModel(response.info));
  } catch (error) { state.taskState = "FAILED"; state.activeTaskId = state.activeTaskId || `local_${Date.now()}`; setStatus("FAILED", error.message); state.messages.push({ role: "assistant", text: `无法提交任务：${error.message}` }); renderMessages(); renderResult(`任务提交失败：${error.message}`); updateCancelVisibility(); }
  finally { updateSendAvailability(); }
}
function completeAssistant(text, model) { const actual = model?.modelID ? actualModel(model) : model; state.assistantText = text; const last = state.messages[state.messages.length - 1]; if (last?.role === "assistant") { last.text = text; last.model = actual; } else state.messages.push({ role: "assistant", text, model: actual }); renderMessages(); renderResult(text); }
function handleTerminal(event) {
  const changed = applyTaskEvent(event.taskId, event.type);
  if (!changed) return;
  const label = { "task.failed": event.error || "执行失败", "task.timeout": "执行超时", "task.cancelled": "已取消", "task.interrupted": "执行中断" }[event.type];
  setStatus(state.taskState, label);
  state.messages.push({ role: "assistant", text: `任务未完成：${event.error || label}` });
  renderMessages(); renderResult(`任务未完成：${event.error || label}`);
  updateCancelVisibility();
}
function showPermission(request) { if (isTerminalState()) return; setStatus("WAITING_PERMISSION", "等待权限"); const box = document.createElement("div"); box.className = "permission"; box.innerHTML = `<strong>OpenCode 请求执行</strong><br><code>${escapeHTML(JSON.stringify(request))}</code><br><button data-choice="once">允许一次</button><button data-choice="reject">拒绝</button>`; $("#resultBody").prepend(box); box.addEventListener("click", async (event) => { const choice = event.target.dataset.choice; if (!choice) return; const id = request.id || request.permissionID || request.requestID; if (id) await api(`/api/permissions/${encodeURIComponent(id)}/reply`, { method: "POST", body: JSON.stringify({ response: choice }) }); box.remove(); if (!isTerminalState()) setStatus("RUNNING", "正在分析"); }); }
function connectEvents() { const stream = new EventSource("/api/events"); stream.addEventListener("mashang", (message) => { const event = JSON.parse(message.data); logEvent(event);
  if (event.type === "worker.status") { state.models = event.models || state.models; if (event.models) renderModelOptions(event.models); setConnection(["ONLINE", "BUSY"].includes(event.status), event.status); return; }
  if (event.type === "session.mapped") { state.openCodeSessionId = event.openCodeSessionId; renderDebug(); return; }
  if (event.type === "task.timeout.warning") { if (!isTerminalState()) setStatusLabel("运行超时，正在尝试取消"); return; }
  if (event.type === "task.accepted") { applyTaskEvent(event.taskId, "task.accepted"); return; }
  if (event.type === "task.running") { applyTaskEvent(event.taskId, "task.running"); return; }
  if (event.type === "agent.message.delta" && event.taskId === state.activeTaskId) { state.assistantText += event.text || ""; renderResult(state.assistantText); return; }
  if (event.type === "agent.message.completed" && event.taskId === state.activeTaskId) { applyTaskEvent(event.taskId, "agent.message.completed"); completeAssistant(event.text || "", event.actualModel); return; }
  if (event.type === "task.completed") { if (applyTaskEvent(event.taskId, "task.completed")) setStatus("COMPLETED"); return; }
  if (["task.failed", "task.timeout", "task.cancelled", "task.interrupted"].includes(event.type)) { handleTerminal(event); return; }
  if (event.type === "artifact.created") { state.artifacts = [...state.artifacts.filter((artifact) => artifact.artifactId !== event.artifactId), { ...event, preview: "" }]; renderArtifacts(); return; }
  if (event.type === "permission.requested") { showPermission({ ...(event.request || {}), id: event.requestId }); return; }
}); stream.onerror = () => { setConnection(false, "OFFLINE"); setTimeout(connectEvents, 2500); stream.close(); }; }

optional("#cancel")?.addEventListener("click", async () => { if (!state.activeTaskId || isTerminalState()) return; try { await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}/cancel`, { method: "POST" }); if (!isTerminalState()) setStatusLabel("正在取消…"); } catch (error) { setStatusLabel(`取消失败：${error.message}`); } });
function autosizePrompt() { const input = optional("#prompt"); if (!input) return; input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
function syncKeyboardInset() { const vv = window.visualViewport; if (!vv) return; const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)); document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`); document.body.classList.toggle("keyboard-open", inset > 80); }
const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
$("#promptForm").addEventListener("submit", (event) => { event.preventDefault(); const input = $("#prompt"); const text = input.value.trim(); if (!text) return; input.value = ""; autosizePrompt(); sendPrompt(text).catch((error) => { state.taskState = "FAILED"; setStatus("FAILED", error.message); state.messages.push({ role: "assistant", text: `无法提交任务：${error.message}` }); renderMessages(); }); });
$("#prompt").addEventListener("input", autosizePrompt);
$("#prompt").addEventListener("keydown", (event) => { if (event.key !== "Enter") return; if (coarsePointer && !event.metaKey && !event.ctrlKey) return; if (!event.shiftKey) { event.preventDefault(); $("#promptForm").requestSubmit(); } });
if (window.visualViewport) { visualViewport.addEventListener("resize", syncKeyboardInset); visualViewport.addEventListener("scroll", syncKeyboardInset); }
window.addEventListener("orientationchange", () => setTimeout(syncKeyboardInset, 300));
autosizePrompt();
$("#newSession").addEventListener("click", async () => { state.session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "mashang-hub" }) }); localStorage.setItem("mashang-hub-session", state.session.id); state.messages = []; state.artifacts = []; state.artifactScanText = ""; state.activeTaskId = null; state.taskState = "IDLE"; state.turnId = null; state.openCodeSessionId = null; renderSession(); renderMessages(); renderResult(""); renderArtifacts(); setStatus("IDLE"); updateCancelVisibility(); renderDebug(); });
optional("#debugToggle")?.addEventListener("click", () => optional("#debug")?.classList.toggle("hidden")); optional("#debugClose")?.addEventListener("click", () => optional("#debug")?.classList.add("hidden"));
async function initialize() { const response = await fetch("/api/auth/status"); const auth = await response.json(); if (auth.required && !auth.authenticated) { showLogin(); return; } setStatus("IDLE"); renderDebug(); updateCancelVisibility(); loadModels(); refreshConnection().then(() => ensureSession().catch(() => {})); connectEvents(); }
initialize();
