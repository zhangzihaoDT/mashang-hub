import { transitionTaskState } from "./task-state.js";
import { initRuntimeUI } from "./runtime-ui.js";

function $(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`DOM contract missing: ${selector}`);
  return element;
}
function optional(selector) { return document.querySelector(selector); }
const initialState = { session: null, connected: false, status: "IDLE", workerStatus: "OFFLINE", taskState: "IDLE", activeTaskId: null, turnId: null, openCodeSessionId: null, events: [], lastRequest: null, lastResponse: null, messages: [], assistantText: "", artifactScanText: "", artifacts: [], models: [], selectedModel: null, turnActive: false, pendingPermission: null, confirmationId: null, earlyEvents: [] };

let state = initialState;
const conversations = { service: state, publish: null };
let currentWorkspace = 'service';
let submitting = false;
let runtimeSnapshot = null;
const workspaceCopy = {
  service: { title:'Service Workspace', eyebrow:'BUSINESS & RESEARCH', placeholder:'描述业务问题、研究主题或报告要求…', welcome:'今天，想研究什么？', description:'提出业务问题，查看分析结论、研究报告与附件。' },
  publish: { title:'Publish Workspace', eyebrow:'DRAFT & REVIEW', placeholder:'描述写作主题，或粘贴需要整理的正文…', welcome:'把想法，整理成文字。', description:'起草、修改和审阅正文。正式发布尚未接入。' },
};
function sessionStorageKey(context = state) { return context === conversations.publish ? 'mashang-hub-publish-session' : 'mashang-hub-session'; }
function refreshExecutionInfo() {
  $('#taskTitle').textContent = state.taskTitle || '等待一项新任务';
  $('#executionInfo').textContent = state.activeTaskId ? [state === conversations.publish ? '内容起草' : '业务分析', state.selectedModel?.label || 'Agent', state.finishedAt && state.startedAt ? `${((state.finishedAt - state.startedAt) / 1000).toFixed(1)} 秒` : state.turnActive ? '执行中' : ''].filter(Boolean).join(' · ') : '任务状态、执行信息和结果汇集在这里。';
}
function renderConversation() {
  renderSession(); renderMessages(); renderResult(state.assistantText, state.resultPlainText); renderArtifacts(); setStatus(state.status); refreshExecutionInfo(); updateCancelVisibility(); updateSendAvailability(); renderDebug();
}
function renderIndependent() {
  const isFetch = currentWorkspace === 'fetch';
  const service = runtimeSnapshot?.services?.find(item => item.id === (isFetch ? 'fetch' : 'myknbase'));
  $('#independentTitle').textContent = isFetch ? 'Fetch Workspace' : 'Knbase Workspace';
  $('#independentIcon').textContent = isFetch ? '◎' : '▤';
  $('#independentHeading').textContent = isFetch ? '数据采集工作台' : '知识工作台';
  $('#independentDescription').textContent = isFetch ? '在 Fetch 原有界面中采集链接、查看任务与管理采集结果。' : '在 Knbase 原有界面中浏览资料、检索文档与整理知识。';
  $('#independentStatus').textContent = !state.connected ? 'Worker 离线' : ({ONLINE:'在线',OFFLINE:'离线',UNKNOWN:'状态未知'})[service?.status] || '等待服务状态';
  const link = $('#independentOpen');
  let url = null; try { const candidate = new URL(service?.openUrl); if (['http:','https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) url = candidate; } catch {}
  link.classList.toggle('hidden', !url); if (url) link.href = url.href; else link.removeAttribute('href');
  $('#independentAddress').textContent = url ? url.href : 'Worker 尚未提供地址';
  const local = url && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  $('#independentHint').textContent = !url ? '连接 Worker 后提供工作台入口。页面操作仍由独立系统处理。' : local ? '这是 Worker 本机地址。手机或其他设备需使用已配置的可达地址；Hub 不会自动代理本地页面。' : '在新窗口打开独立 UI，保留当前 Hub 工作空间。服务状态不代表此设备已验证访问。';
}
function switchWorkspace(kind) {
  if (submitting) return;
  state.draft = $('#prompt').value;
  currentWorkspace = kind;
  for (const button of $('#workspaceNav').querySelectorAll('[data-workspace]')) { const active = button.dataset.workspace === kind; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  const conversational = kind === 'service' || kind === 'publish';
  $('#conversationWorkspace').classList.toggle('hidden', !conversational); $('#independentWorkspace').classList.toggle('hidden', conversational);
  if (!conversational) { renderIndependent(); return; }
  if (!conversations[kind]) conversations[kind] = { ...initialState, session:null, activeTaskId:null, turnId:null, taskState:'IDLE', status:'IDLE', turnActive:false, messages:[], artifacts:[], assistantText:'', pendingPermission:null, confirmationId:null, earlyEvents:[], draft:'', taskTitle:null, sessionPromise:null, openCodeSessionId:null, resultPlainText:false, startedAt:null, finishedAt:null };
  const previous = state; state = conversations[kind];
  state.connected = previous.connected; state.workerStatus = previous.workerStatus; state.models = previous.models;
  if (!state.selectedModel) state.selectedModel = previous.selectedModel;
  const copy = workspaceCopy[kind]; $('#workspaceTitle').textContent = copy.title; $('#workspaceEyebrow').textContent = copy.eyebrow; $('#workspaceNotice').classList.toggle('hidden', kind !== 'publish');
  $('#prompt').placeholder = copy.placeholder; $('#prompt').value = state.draft || ''; autosizePrompt();
  renderConversation(); renderModelOptions(state.models);
  if (!state.session) ensureSession().catch(error => { if (state === conversations[kind]) pushNotice(error.message); });
}
$('#workspaceNav').addEventListener('click', event => { const button = event.target.closest('[data-workspace]'); if (button) switchWorkspace(button.dataset.workspace); });
const TASK_LABELS = { IDLE: "等待输入", SUBMITTING: "正在提交", UNDERSTANDING: "正在理解请求", PLANNING: "正在规划", RUNNING: "正在分析", RENDERING: "正在整理结果", COMPLETED: "分析完成", FAILED: "执行失败", INTERRUPTED: "执行中断", TIMEOUT: "执行超时", CANCELLED: "已取消", WAITING_PERMISSION: "等待权限", ERROR: "连接错误" };

function escapeHTML(value = "") { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function markdownTable(lines, start) {
  const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  if (start + 1 >= lines.length || !lines[start].includes("|") || !isDivider(lines[start + 1])) return null;
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const headers = splitRow(lines[start]);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(splitRow(lines[index])); index += 1; }
  return { headers, rows, next: index };
}
function markdown(value = "") {
  const blocks = [];
  let text = escapeHTML(value).replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${code.trim()}</code></pre>`); return `\x00${blocks.length - 1}\x00`; });
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    const table = markdownTable(lines, i);
    if (!table) { out.push(lines[i]); i += 1; continue; }
    const head = `<thead><tr>${table.headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
    const body = table.rows.length ? `<tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>` : "";
    blocks.push(`<div class="md-table"><table>${head}${body}</table></div>`);
    out.push("", `\x00${blocks.length - 1}\x00`, "");
    i = table.next;
  }
  text = out.join("\n");
  text = text.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h2>$1</h2>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.split(/\n{2,}/).map((paragraph) => paragraph.startsWith("\x00") ? paragraph : `<p>${paragraph.replaceAll("\n", "<br>")}</p>`).join("");
  return text.replace(/\x00(\d+)\x00/g, (_, index) => blocks[index]);
}
function sessionName(session) { return session?.title || session?.name || session?.id?.slice(0, 16) || "未创建"; }
function updateSendAvailability() { $("#send").disabled = state.turnActive || submitting || !state.connected || !state.selectedModel?.available; }
function setConnection(connected, status = state.workerStatus) { for (const context of Object.values(conversations)) if (context) { context.connected = connected; context.workerStatus = status; } state.connected = connected; state.workerStatus = status; $("#connection").className = `connection ${connected ? "connected" : "disconnected"}`; $("#connection span").textContent = `Mac Worker ${status === "BUSY" ? "Running" : connected ? "Online" : "Offline"}`; updateSendAvailability(); if (["fetch","knbase"].includes(currentWorkspace)) renderIndependent(); }
function taskLabel(status) { return state === conversations.publish ? ({RUNNING:'正在起草',COMPLETED:'草稿已完成'})[status] || TASK_LABELS[status] || status : TASK_LABELS[status] || status; }
function setStatus(status, label) { state.status = status; refreshExecutionInfo(); const el = $("#runState"); el.className = `run-state ${status.toLowerCase()}`; el.querySelector("span:last-child").textContent = label || taskLabel(status); if (state.turnActive) recordProcess(status, label); }
function setStatusLabel(label) { const el = optional("#runState"); if (el) el.querySelector("span:last-child").textContent = label; }
function isTerminalState() { return ["COMPLETED", "FAILED", "INTERRUPTED", "TIMEOUT", "CANCELLED"].includes(state.taskState); }
function updateCancelVisibility() { const button = optional("#cancel"); if (!button) return; button.classList.toggle("hidden", !state.activeTaskId || isTerminalState()); }
function applyTaskEvent(taskId, type, label) {
  const result = transitionTaskState({ taskId: state.activeTaskId, status: state.taskState }, { taskId, type });
  if (result.taskId === state.activeTaskId && result.status === state.taskState) return false;
  state.activeTaskId = result.taskId;
  state.taskState = result.status;
  setStatus(result.status, label);
  updateCancelVisibility();
  return true;
}
function renderSession() { $("#sessionMeta").textContent = state.session ? `当前对话 · ${state.selectedModel ? modelLabel(state.selectedModel) : "选择执行模型"}` : "正在创建对话…"; }
function renderMessage(item) {
  if (item.role === "user") return `<div class="message user"><div class="label">任务描述</div><div class="bubble">${escapeHTML(item.text)}</div></div>`;
  if (item.kind === 'result') return `<article class="history-result"><div class="history-result-head"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(TASK_LABELS[item.status] || item.status)}</span></div><div>${item.plainText ? `<pre>${escapeHTML(item.text)}</pre>` : markdown(item.text)}</div>${(item.artifacts || []).map(artifact => `<div class="history-attachment"><span>${escapeHTML(artifact.name)}</span><a href="${artifactURL('/api/artifacts/content', artifact.artifactId)}" target="_blank" rel="noopener">查看附件</a><a href="${artifactURL('/api/artifacts/download', artifact.artifactId)}" download>下载</a></div>`).join('')}</article>`;
  if (item.kind === "notice") return `<div class="message assistant notice ${escapeHTML(item.level || "info")}"><div class="label">任务提示</div><div class="bubble">${escapeHTML(item.text)}</div></div>`;
  const steps = (item.steps || []).map((step) => `<li class="step ${escapeHTML(step.status)}"><span class="step-dot"></span><span>${escapeHTML(step.label)}</span></li>`).join("");
  const meta = item.model ? `<div class="message-meta">${escapeHTML(item.model.label || item.model.modelID || "OpenCode")}</div>` : "";
  return `<div class="message assistant process"><div class="label">Assistant</div><ul class="process-steps">${steps}</ul>${meta}</div>`;
}
function permissionHTML() {
  const request = state.pendingPermission || {};
  return `<div class="permission"><strong>OpenCode 请求执行</strong><code>${escapeHTML(JSON.stringify(request.request || {}))}</code><div class="permission-actions"><button data-choice="once">允许一次</button><button data-choice="reject">拒绝</button></div></div>`;
}
function renderMessages() {
  const container = $("#messages");
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const body = state.messages.length ? state.messages.map(renderMessage).join("") : `<div class="welcome"><img class="avatar" src="/raccoon.png" width="42" height="42" alt="mashang" /><h2>${workspaceCopy[state === conversations.publish ? "publish" : "service"].welcome}</h2><p>${workspaceCopy[state === conversations.publish ? "publish" : "service"].description}</p></div>`;
  container.innerHTML = body + (state.pendingPermission ? permissionHTML() : "");
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
function currentProcessMessage() { const last = state.messages[state.messages.length - 1]; return last && last.role === "assistant" && last.kind === "process" ? last : null; }
function ensureProcessMessage() { let message = currentProcessMessage(); if (!message) { message = { role: "assistant", kind: "process", steps: [], model: null }; state.messages.push(message); } return message; }
function processStepStatus(status) { if (status === "COMPLETED") return "done"; if (["FAILED", "TIMEOUT", "CANCELLED", "INTERRUPTED", "ERROR"].includes(status)) return "error"; return "running"; }
function recordProcess(status, label) {
  const text = label || taskLabel(status);
  const message = ensureProcessMessage();
  const previous = message.steps[message.steps.length - 1];
  if (previous && previous.label === text) return;
  message.steps.forEach((step) => { if (step.status === "running") step.status = "done"; });
  message.steps.push({ label: text, status: processStepStatus(status) });
  renderMessages();
}
function pushProcessNote(label) { const message = ensureProcessMessage(); message.steps.push({ label, status: "note" }); renderMessages(); }
function updateRunningLabel(label) { const message = currentProcessMessage(); const step = message?.steps[message.steps.length - 1]; if (!step || step.status !== "running" || step.label === label) return; step.label = label; renderMessages(); }
function pushNotice(text, level = "error") { state.messages.push({ role: "assistant", kind: "notice", text, level }); renderMessages(); }
function renderResult(text, plainText = false) { $("#resultContent").innerHTML = text ? (plainText ? `<pre style="white-space:pre-wrap">${escapeHTML(text)}</pre>` : markdown(text)) : `<div class="empty-result"><span>◌</span><p>确认执行后，回答与附件会显示在这里。</p></div>`; }
function artifactCandidates(text = "") { const pattern = /(?:^|[\s"'`(])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\.(?:md|html|csv|png))(?=$|[\s"'`),.;])/gu; return [...text.matchAll(pattern)].map((match) => match[1]); }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function artifactURL(endpoint, artifactId) { return `${endpoint}?artifactId=${encodeURIComponent(artifactId)}`; }
function ensureArtifactMount() { let box = optional("#artifacts"); if (!box) { box = document.createElement("div"); box.id = "artifacts"; box.className = "artifacts hidden"; $("#resultBody").append(box); } return box; }
function renderArtifacts() {
  let box = optional("#artifacts");
  if (!state.artifacts.length) { if (box) { box.classList.add("hidden"); box.innerHTML = ""; } return; }
  box = box || ensureArtifactMount();
  box.classList.remove("hidden");
  box.innerHTML = `<div class="artifacts-title"><span>任务附件</span><small>${state.artifacts.length} 个文件</small></div>${state.artifacts.map((artifact, index) => `<div class="artifact-card" data-index="${index}"><div class="artifact-icon artifact-${artifact.extension.slice(1)}">${artifact.extension.slice(1).toUpperCase()}</div><div class="artifact-info"><strong>${escapeHTML(artifact.name)}</strong><span>${escapeHTML(artifact.artifactType || ({".md":"Markdown",".html":"HTML",".csv":"CSV",".png":"图片"})[artifact.extension] || "附件")} · ${formatBytes(artifact.size)}</span><small title="${escapeHTML(artifact.path || artifact.name)}">${escapeHTML(artifact.path || "Local artifact")}</small></div><div class="artifact-actions">${artifact.extension === ".csv" ? "" : `<button data-action="preview">预览</button>`}<a class="artifact-download" href="${artifactURL("/api/artifacts/download", artifact.artifactId)}" download>下载</a></div>${artifact.preview ? `<div class="artifact-preview">${artifact.preview}</div>` : ""}</div>`).join("")}`;
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
$("#messages").addEventListener("click", async (event) => { const button = event.target.closest("[data-choice]"); if (!button || !state.pendingPermission) return; const choice = button.dataset.choice; const id = state.pendingPermission.id; state.pendingPermission = null; renderMessages(); try { if (id) await api(`/api/permissions/${encodeURIComponent(id)}/reply`, { method: "POST", body: JSON.stringify({ response: choice }) }); if (!isTerminalState()) setStatus("RUNNING", "正在分析"); } catch { /* keep UI responsive */ } });
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
  const defaultModel = models.find(model => model.key === state.selectedModel?.key && model.available) || models.find((model) => model.key === "deepseek" && model.available) || models.find(model => model.available);
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
async function refreshConnection() { try { const health = await api("/api/health"); setConnection(Boolean(health.connected), health.worker?.status || "OFFLINE"); } catch { setConnection(false); setStatus("ERROR", "OpenCode Server 未运行"); pushNotice("OpenCode Server 未运行。请在另一个 Terminal 启动：opencode serve --hostname 127.0.0.1 --port 4096"); } }
function ensureSession() {
  const context = state;
  if (context.sessionPromise) return context.sessionPromise;
  context.sessionPromise = restoreSession(context).finally(() => { context.sessionPromise = null; });
  return context.sessionPromise;
}
async function restoreSession(context) {
  const sessions = await api("/api/sessions");
  const savedID = localStorage.getItem(sessionStorageKey(context));
  context.session = sessions.find?.((item) => item.id === savedID);
  if (!context.session) context.session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "mashang-hub" }) });
  localStorage.setItem(sessionStorageKey(context), context.session.id);
  if (state === context) { renderSession(); renderDebug(); }
  const latest = (await api('/api/tasks')).find(task => task.conversationId === context.session.id && ['DISPATCHED', 'RUNNING', 'INTERRUPTED', 'UNCERTAIN'].includes(task.status));
  if (latest && !context.activeTaskId) { context.activeTaskId = latest.taskId; context.turnId = latest.turnId; context.taskState = latest.status === 'DISPATCHED' ? 'SUBMITTING' : latest.status === 'UNCERTAIN' ? 'INTERRUPTED' : latest.status; context.turnActive = latest.status === 'RUNNING' || latest.status === 'DISPATCHED'; if (state === context) setStatus(context.taskState, latest.status === 'UNCERTAIN' ? '结果待核对，禁止自动重试' : latest.status === 'INTERRUPTED' ? '等待 Worker 执行对账' : '已恢复任务状态'); updateCancelVisibility(); }
}
function parseMessage(data) { return (data?.parts || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n"); }
function actualModel(info) { const modelID = info?.modelID || info?.model?.id; const providerID = info?.providerID || info?.model?.providerID; const known = state.models?.find((model) => model.modelID === modelID && model.providerID === providerID); return { label: known ? modelLabel(known) : modelID ? `${providerID || ""}/${modelID}` : "Unknown model", modelID, providerID, cost: info?.cost, tokens: info?.tokens }; }
async function sendPrompt(text) {
  if (state.turnActive || submitting) return;
  submitting = true;
  if (state.activeTaskId && (state.assistantText || state.artifacts.length)) state.messages.push({ role:'assistant',kind:'result',text:state.assistantText,status:state.taskState,title:state.taskTitle,plainText:state.resultPlainText,artifacts:state.artifacts.map(item=>({...item})) });
  state.taskTitle = text.trim().slice(0, 48); state.resultPlainText = false; state.startedAt = Date.now(); state.finishedAt = null;
  state.messages.push({ role: "user", text });
  state.assistantText = ""; state.artifactScanText = ""; state.artifacts = [];
  state.activeTaskId = null; state.taskState = "UNDERSTANDING"; state.turnActive = true; state.pendingPermission = null;
  renderMessages(); renderResult(""); renderArtifacts(); setStatus("UNDERSTANDING"); updateCancelVisibility(); $("#send").disabled = true;
  try {
    if (!state.session) await ensureSession();
    if (!state.selectedModel?.available) throw new Error("请选择可用模型");
    const response = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/message`, { method: "POST", body: JSON.stringify({ model: { providerID: state.selectedModel.providerID, modelID: state.selectedModel.modelID }, parts: [{ type: "text", text: state === conversations.publish ? `这是内容起草与审阅请求，只生成或修改文字，不执行发布。\n\n${text}` : text }], confirmationId: state.confirmationId }) });
    if (response.taskId) { if (response.turnId) state.turnId = response.turnId; applyTaskEvent(response.taskId, "task.accepted"); }
    for (const event of state.earlyEvents.splice(0)) handleServerEvent(event);
    renderDebug();
    const answer = parseMessage(response) || response?.text || response?.message?.text;
    if (answer) completeAssistant(answer, actualModel(response.info));
  } catch (error) {
    state.taskState = "FAILED"; state.activeTaskId = state.activeTaskId || `local_${Date.now()}`;
    setStatus("FAILED", `任务提交失败：${error.message}`); state.turnActive = false;
    renderResult(""); updateCancelVisibility();
  } finally { submitting = false; updateSendAvailability(); }
}
function completeAssistant(text, model, plainText = false) { const actual = model?.modelID ? actualModel(model) : model; state.assistantText = text; const message = ensureProcessMessage(); if (actual) message.model = actual; recordProcess("RENDERING"); renderResult(text, plainText); state.resultPlainText = plainText; }
function handleTerminal(event) {
  const label = event.error || { "task.failed": event.error || "执行失败", "task.timeout": "执行超时", "task.cancelled": "已取消", "task.interrupted": "执行中断" }[event.type];
  const changed = applyTaskEvent(event.taskId, event.type, label);
  if (!changed) return;
  state.turnActive = false;
  renderResult("");
  updateCancelVisibility(); updateSendAvailability();
}
function showPermission(request) { if (isTerminalState()) return; state.pendingPermission = request; setStatus("WAITING_PERMISSION", "等待权限"); renderMessages(); }
function handleServerEvent(event) {
  if (event.type === "permission.requested" && event.request?.sessionID) {
    const target = Object.values(conversations).find(context=>context?.openCodeSessionId === event.request.sessionID);
    if (!target) return;
    if (target !== state) { const visible=state; state=target; try { processServerEvent(event); } finally { state=visible; renderConversation(); } return; }
  }
  if (event.taskId) {
    const target = Object.values(conversations).find(context => context && (context.activeTaskId === event.taskId || (!context.activeTaskId && context.turnActive && context.session?.id === event.sessionId)));
    if (!target) return;
    if (target !== state) { const visible = state; state = target; try { processServerEvent(event); } finally { state = visible; renderConversation(); } return; }
  }
  processServerEvent(event);
}
function processServerEvent(event) {
  if (event.taskId && !state.activeTaskId && state.turnActive) { state.earlyEvents.push(event); return; }
  logEvent(event);
  if (event.type === "runtime.snapshot" || event.type === "runtime.control.permission.requested" || event.type === "runtime.control.updated") { runtimeUI.update(event); if (event.type === "runtime.snapshot") { runtimeSnapshot = event.snapshot; if (["fetch","knbase"].includes(currentWorkspace)) renderIndependent(); } return; }
  if (event.type === "worker.status") { state.models = event.models || state.models; for (const context of Object.values(conversations)) if (context) context.models = state.models; if (event.models) renderModelOptions(event.models); setConnection(["ONLINE", "BUSY"].includes(event.status), event.status); return; }
  if (event.type === "session.mapped") { state.openCodeSessionId = event.openCodeSessionId; renderDebug(); return; }
  if (event.type === "task.timeout.warning") { if (!isTerminalState()) { setStatusLabel("运行超时，正在尝试取消"); updateRunningLabel("运行超时，正在尝试取消"); } return; }
  if (event.type === 'task.resumed' && event.taskId === state.activeTaskId) { applyTaskEvent(event.taskId, 'task.resumed'); state.turnActive = true; pushProcessNote('已核对 Worker 执行，任务继续运行'); return; }
  if (event.type === 'task.progress.stalled' && event.taskId === state.activeTaskId) { pushProcessNote(event.error); return; }
  if (event.type === "task.accepted") { applyTaskEvent(event.taskId, "task.accepted"); return; }
  if (event.type === "task.running") { applyTaskEvent(event.taskId, "task.running"); return; }
  if (event.type === "agent.message.delta" && event.taskId === state.activeTaskId) { state.assistantText += event.text || ""; updateRunningLabel("正在生成结果"); return; }
  if (event.type === "agent.message.completed" && event.taskId === state.activeTaskId) { applyTaskEvent(event.taskId, "agent.message.completed"); if (Object.hasOwn(event, "confirmationId")) state.confirmationId = event.confirmationId; completeAssistant(event.text || state.assistantText, event.actualModel, event.plainText === true); return; }
  if (event.type === "task.completed") { state.finishedAt = Date.now(); if (applyTaskEvent(event.taskId, "task.completed")) state.turnActive = false; updateSendAvailability(); return; }
  if (["task.failed", "task.timeout", "task.cancelled", "task.interrupted"].includes(event.type)) { handleTerminal(event); return; }
  if (event.type === "artifact.created" && event.taskId === state.activeTaskId) { state.artifacts = [...state.artifacts.filter((artifact) => artifact.artifactId !== event.artifactId), { ...event, preview: "" }]; renderArtifacts(); pushProcessNote(`已生成 ${event.name || event.path || "文件"}`); return; }
  if (event.type === "permission.requested") { showPermission({ id: event.requestId, request: event.request || {} }); return; }
}
function connectEvents() { const stream = new EventSource("/api/events"); stream.addEventListener("mashang", (message) => handleServerEvent(JSON.parse(message.data))); stream.onerror = () => { setConnection(false, "OFFLINE"); setTimeout(connectEvents, 2500); stream.close(); }; }

optional("#cancel")?.addEventListener("click", async () => { if (!state.activeTaskId || isTerminalState()) return; try { await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}/cancel`, { method: "POST" }); if (!isTerminalState()) { setStatusLabel("正在取消…"); updateRunningLabel("正在取消…"); } } catch (error) { setStatusLabel(`取消失败：${error.message}`); } });
function autosizePrompt() { const input = optional("#prompt"); if (!input) return; input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
function syncKeyboardInset() { const vv = window.visualViewport; if (!vv) return; const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)); document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`); document.body.classList.toggle("keyboard-open", inset > 80); }
const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
$("#promptForm").addEventListener("submit", (event) => { event.preventDefault(); const input = $("#prompt"); const text = input.value; if (!text.trim() || $("#send").disabled) return; input.value = ""; autosizePrompt(); sendPrompt(text).catch((error) => { state.taskState = "FAILED"; state.turnActive = false; setStatus("FAILED", `任务提交失败：${error.message}`); pushNotice(`无法提交任务：${error.message}`); }); });
$("#prompt").addEventListener("input", autosizePrompt);
$("#prompt").addEventListener("keydown", (event) => { if (event.key !== "Enter") return; if (coarsePointer && !event.metaKey && !event.ctrlKey) return; if (!event.shiftKey) { event.preventDefault(); $("#promptForm").requestSubmit(); } });
if (window.visualViewport) { visualViewport.addEventListener("resize", syncKeyboardInset); visualViewport.addEventListener("scroll", syncKeyboardInset); }
window.addEventListener("orientationchange", () => setTimeout(syncKeyboardInset, 300));
autosizePrompt();
$('#newSession').addEventListener('click', async () => {
  if (state.turnActive || submitting) return;
  submitting = true; updateSendAvailability();
  try {
    state.session = await api('/api/sessions', { method:'POST', body:JSON.stringify({title:'mashang-hub'}) });
    localStorage.setItem(sessionStorageKey(), state.session.id);
    Object.assign(state, {messages:[],artifacts:[],artifactScanText:'',activeTaskId:null,taskState:'IDLE',turnId:null,openCodeSessionId:null,turnActive:false,pendingPermission:null,confirmationId:null,earlyEvents:[],taskTitle:null,draft:'',assistantText:'',resultPlainText:false,startedAt:null,finishedAt:null});
    $('#prompt').value = ''; renderConversation(); autosizePrompt();
  } catch (error) { pushNotice(`无法创建新对话：${error.message}`); }
  finally { submitting = false; updateSendAvailability(); }
});

optional("#debugToggle")?.addEventListener("click", () => optional("#debug")?.classList.toggle("hidden")); optional("#debugClose")?.addEventListener("click", () => optional("#debug")?.classList.add("hidden"));
const runtimeUI = initRuntimeUI();
async function initialize() { const response = await fetch("/api/auth/status"); const auth = await response.json(); if (auth.required && !auth.authenticated) { showLogin(); return; } setStatus("IDLE"); renderDebug(); updateCancelVisibility(); loadModels(); refreshConnection().then(() => ensureSession().catch(() => {})); fetch("/api/runtime").then(response=>response.json()).then(data=>{ runtimeSnapshot = data.snapshot; if (["fetch","knbase"].includes(currentWorkspace)) renderIndependent(); }).catch(()=>{}); renderMessages(); connectEvents(); }
initialize();
