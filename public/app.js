import { createNoteInput } from './note-input.js';
import { contentCardHTML, contentCopy } from './content-ui.js';
import { selectAvailableModel } from './model-selection.js';
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
const conversations = { service: state, publish: null, aksignal: null };
let currentWorkspace = 'service';
const marketComposerPreference = localStorage.getItem('aksignal-composer-collapsed');
let marketComposerCollapsed = marketComposerPreference === null ? true : marketComposerPreference === '1';
let submitting = false;
let noteInput;
const linkedContentSession = new URLSearchParams(location.search).get('workspace') === 'publish'
  ? new URLSearchParams(location.search).get('conversation') : null;
let contentSyncing = false;
let runtimeSnapshot = null;
const workspaceCopy = {
  service: { title:'Service', eyebrow:'BUSINESS & RESEARCH', placeholder:'描述业务问题、研究主题或报告要求…', welcome:'今天，想研究什么？', description:'提出业务问题，查看分析结论、研究报告与附件。' },
  aksignal: {title:'AKsignal',eyebrow:'MARKET FACTS',placeholder:'围绕本期市场事实提问…',welcome:'读懂本期市场',description:'基于正式日报讨论市场方向、趋势与底部位置。'},
  publish: { title:'Content', eyebrow:'NOTES & PUBLISH', placeholder:'描述写作主题，或粘贴需要整理的正文…', welcome:'把想法，整理成文字。', description:'记录想法，整理笔记，也可以同步 Flomo 或发布微博。' },
};
function sessionStorageKey(context = state) { return context === conversations.aksignal ? 'mashang-hub-aksignal-session' : context === conversations.publish ? 'mashang-hub-publish-session' : 'mashang-hub-session'; }
function updateContentMode(mode = state.contentMode || 'notes') {
  state.contentMode = mode;
  const active = currentWorkspace === 'publish';
  document.body.classList.toggle('content-workspace', active);
  $('#contentModes').classList.toggle('hidden', !active);
  for (const button of $('#contentModes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.contentMode === mode));
  const publishing = active && mode === 'publish';
  for (const id of ['previewPublication','publicationVisibility','publicationStatement']) $('#'+id).classList.toggle('hidden', !publishing);
  $('#workspaceNotice').classList.add('hidden');
  $('#send').classList.toggle('hidden', active && mode === 'notes');
  document.querySelector('.composer .hint').textContent = active && mode === 'notes' ? 'Enter 保存 · Shift + Enter 换行' : 'Enter 发送 · Shift + Enter 换行';
  if (active) $('#debug').classList.add('hidden');
  if (active) $('#prompt').placeholder = contentCopy[mode].placeholder;
  const span = $('#connection span');
  if (active) span.textContent = state.connected ? '已连接' : '连接中…';
  updateNoteActions();
}
$('#contentModes').addEventListener('click', event => {
  const mode = event.target.closest('[data-content-mode]')?.dataset.contentMode;
  if (!mode) return;
  updateContentMode(mode); renderMessages(); renderResult(state.assistantText, state.resultPlainText);
});
function refreshExecutionInfo() {
  $('#resultBody').classList.toggle('hidden', !state.turnActive && !state.activeTaskId && !state.assistantText && !state.artifacts.length && !state.operationControl);
  $('#taskTitle').textContent = state.taskTitle || '等待一项新任务';
  $('#executionInfo').textContent = state.activeTaskId ? [state === conversations.publish ? '内容起草' : '业务分析', state.selectedModel?.label || 'Agent', state.finishedAt && state.startedAt ? `${((state.finishedAt - state.startedAt) / 1000).toFixed(1)} 秒` : state.turnActive ? '执行中' : ''].filter(Boolean).join(' · ') : '任务状态、执行信息和结果汇集在这里。';
}
function renderPublication() {
  const mount = $('#publicationReview');
  const context = state;
  const control = context.operationControl;
  mount.classList.toggle('hidden', !control || state !== conversations.publish);
  if (!control) { mount.innerHTML = ''; return; }
  const action = control.actionLabel || '发布微博';
  const labels = { DRAFT:'', PENDING_APPROVAL:'请确认本次内容', APPROVED:'正在处理…', RUNNING:'正在处理…', COMPLETED: action === '发布微博' ? '已发布微博' : '已同步到 Flomo', FAILED: action === '发布微博' ? '发布失败，请检查后再操作。' : '同步失败，请检查后再操作。', UNKNOWN:'尚未确认是否发送成功，请先核对', CANCELLED:'内容已修改，请重新预览' };
  mount.innerHTML = `<p class="content-feedback ${['PENDING_APPROVAL','UNKNOWN'].includes(control.status) ? 'needs-attention' : ''}" role="status">${escapeHTML(labels[control.status] || '')}</p>`
    + (control.status === 'PENDING_APPROVAL' && state.reviewedDigest === control.digest ? `<button type="button" id="approvePublication">确认${escapeHTML(action)}</button>` : '')
    + (control.status === 'UNKNOWN' ? '<button type="button" id="verifyPublication">检查结果</button>' : '')
    + (control.resultUrl ? `<a href="${escapeHTML(control.resultUrl)}" target="_blank" rel="noopener noreferrer">查看微博 ↗</a>` : '');
  optional('#approvePublication')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try {
      const update = await api(`/api/runtime/controls/${encodeURIComponent(control.controlId)}/decision`, { method:'POST', body:JSON.stringify({approve:true,digest:control.digest}) });
      // SSE may deliver the result before the approval HTTP response arrives.
      if (context.operationControl?.controlId === control.controlId && !['COMPLETED','FAILED','UNKNOWN','CANCELLED'].includes(context.operationControl.status)) context.operationControl = update;
    }
    catch (error) { pushNotice(error.message); }
    renderPublication();
  });
  optional('#verifyPublication')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { await api(`/api/runtime/controls/${encodeURIComponent(control.controlId)}/reconcile`, {method:'POST'}); } catch (error) { pushNotice(error.message); }
  });
}
function renderConversation() {
  renderPublication(); renderSession(); renderMessages(); renderResult(state.assistantText, state.resultPlainText); renderArtifacts(); setStatus(state.status); refreshExecutionInfo(); updateCancelVisibility(); updateSendAvailability(); renderDebug();
}
function renderIndependent() {
  const app = ({
    fetch: {serviceId:'fetch', title:'Fetch', heading:'独立工作台 · 由 Fetch 自身维护', description:'数据采集 · 内容解析 · 结果管理'},
    knbase: {serviceId:'myknbase', title:'Knbase', heading:'独立工作台 · 由 Knbase 自身维护', description:'资料浏览 · 知识检索 · 文档管理'},
    miit: {serviceId:'miit', title:'MIIT', heading:'独立工作台 · 由 MIIT 自身维护', description:'公告采集 · 任务执行 · 报告浏览'},
  })[currentWorkspace];
  if (!app) return;
  const service = runtimeSnapshot?.services?.find(item => item.id === app.serviceId);
  $('#independentTitle').textContent = app.title;
  $('#independentHeading').textContent = app.heading;
  $('#independentDescription').textContent = app.description;
  const link = $('#independentOpen');
  let url = null; try { const candidate = new URL(service?.openUrl); if (['http:','https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) url = candidate; } catch {}
  link.classList.toggle('hidden', !url); if (url) link.href = url.href; else link.removeAttribute('href');
  $('#independentAddress').textContent = url ? url.href : 'Worker 尚未提供地址';
  const local = url && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  $('#independentHint').textContent = !url ? '连接 Worker 后提供工作台入口。页面操作仍由独立系统处理。' : local ? '这是 Worker 本机地址。手机或其他设备需使用已配置的可达地址；Hub 不会自动代理本地页面。' : '在新窗口打开独立 UI，保留当前 Hub 工作空间。服务状态不代表此设备已验证访问。';
}
function updateMarketComposer() {
  const active=currentWorkspace === 'aksignal',collapsed=active && marketComposerCollapsed;
  $('#composerCollapseBar').classList.toggle('hidden',!active);
  document.querySelector('.composer').classList.toggle('market-composer-collapsed',collapsed);
  $('#toggleMarketComposer').textContent=collapsed ? '展开讨论 ▴' : '收起讨论 ▾';
  $('#toggleMarketComposer').setAttribute('aria-expanded',String(!collapsed));
}
$('#toggleMarketComposer').addEventListener('click',()=>{
  marketComposerCollapsed=!marketComposerCollapsed;
  localStorage.setItem('aksignal-composer-collapsed',marketComposerCollapsed ? '1':'0');
  updateMarketComposer();
  if(!marketComposerCollapsed) $('#prompt').focus();
});
function switchWorkspace(kind) {
  if (submitting) return;
  state.draft = $('#prompt').value;
  state.publicationVisibility = $('#publicationVisibility').value; state.publicationStatement = $('#publicationStatement').value;
  currentWorkspace = kind;
  updateMarketComposer();
  runtimeUI.setWorkspace(kind);
  document.body.classList.toggle('content-workspace', kind === 'publish');
  $('#contentModes').classList.toggle('hidden', kind !== 'publish');
  for (const button of $('#workspaceNav').querySelectorAll('[data-workspace]')) { const active = button.dataset.workspace === kind; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  const conversational = kind === 'service' || kind === 'publish' || kind === 'aksignal';
  $('#conversationWorkspace').classList.toggle('hidden', !conversational); $('#independentWorkspace').classList.toggle('hidden', conversational || kind === 'aksignal'); $('#businessWorkspace').classList.add('hidden'); $('#marketReport').classList.toggle('hidden',kind !== 'aksignal'); $('#marketBinding').classList.toggle('hidden',kind !== 'aksignal');

  if (!conversational) { renderIndependent(); return; }
  if (!conversations[kind]) conversations[kind] = { ...initialState, session:null, activeTaskId:null, turnId:null, taskState:'IDLE', status:'IDLE', turnActive:false, messages:[], artifacts:[], assistantText:'', pendingPermission:null, confirmationId:null, earlyEvents:[], draft:'', taskTitle:null, sessionPromise:null, openCodeSessionId:null, resultPlainText:false, startedAt:null, finishedAt:null };
  const previous = state; state = conversations[kind];
  state.connected = previous.connected; state.workerStatus = previous.workerStatus; state.models = previous.models;
  if (!state.selectedModel) state.selectedModel = previous.selectedModel;
  const copy = workspaceCopy[kind]; $('#workspaceTitle').textContent = copy.title; $('#workspaceEyebrow').textContent = copy.eyebrow; $('#workspaceNotice').classList.toggle('hidden', kind !== 'publish');
  $('#previewPublication').classList.toggle('hidden', kind !== 'publish');
  for (const id of ['publicationVisibility','publicationStatement']) $('#'+id).classList.toggle('hidden', kind !== 'publish');
  $('#publicationVisibility').value = state.publicationVisibility || 'public'; $('#publicationStatement').value = state.publicationStatement || 'original';
  $('#prompt').placeholder = copy.placeholder; $('#prompt').value = state.draft || ''; autosizePrompt();
  updateContentMode();
  if(kind !== 'publish') setConnection(state.connected, state.workerStatus);
  renderConversation(); renderModelOptions(state.models); if(kind === "aksignal") renderMarketBinding();
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
function latestMarketArtifact() {return runtimeSnapshot?.operations?.find(o=>o.workspace==='aksignal')?.artifacts?.find(a=>a.extension==='.html');}
function bindMarket() {
  if(!state.marketArtifact && state.session) {try{state.marketArtifact=JSON.parse(localStorage.getItem(`market:${state.session.id}`));}catch{}}
  if(!state.marketArtifact) state.marketArtifact=latestMarketArtifact();
  if(state.marketArtifact && state.session) localStorage.setItem(`market:${state.session.id}`,JSON.stringify(state.marketArtifact));
  return state.marketArtifact;
}
function renderMarketBinding() {
  if(state !== conversations.aksignal) return;
  if(!state.marketArtifact && state.session) {try{state.marketArtifact=JSON.parse(localStorage.getItem(`market:${state.session.id}`));}catch{}}
  const a=state.marketArtifact || latestMarketArtifact(),latest=latestMarketArtifact();
  $('#marketBinding').innerHTML=`<span>${a ? `基于 ${escapeHTML(a.targetDate)} 正式日报 · 只读讨论` : '暂无正式日报'}</span>${state.marketArtifact && latest?.artifactId !== state.marketArtifact.artifactId ? '<span> · 新日报可用，开始新对话切换批次</span>' : ''}<div class="market-questions"><button type="button" data-market-question="概括本期市场方向与趋势">概括本期市场</button><button type="button" data-market-question="哪些行业已经形成趋势？">行业趋势</button><button type="button" data-market-question="数据缺口影响哪些结论？">数据质量影响</button></div>`;
}
$('#marketBinding').addEventListener('click',event=>{const q=event.target.closest('[data-market-question]');if(q){$('#prompt').value=q.dataset.marketQuestion;autosizePrompt();$('#prompt').focus();}});
function sessionName(session) { return session?.title || session?.name || session?.id?.slice(0, 16) || "未创建"; }
function updateNoteActions() {
  const active = currentWorkspace === 'publish' && (state.contentMode || 'notes') === 'notes';
  $('#noteComposerActions').classList.toggle('hidden', !active);
  const typed = $('#prompt').value.trim().length > 0 || Boolean(noteInput?.count);
  noteInput?.render();
  const card = state.contentCard;
  const hasContent = typed || Boolean(card?.text || state.assistantText);
  const busy = state.turnActive || submitting || noteInput?.reading;
  const changed = typed && (!card || $('#prompt').value !== card.text);
  const syncBlocked = !changed && Boolean(card && state.operationControl && ['PENDING_APPROVAL','APPROVED','RUNNING','COMPLETED','UNKNOWN'].includes(state.operationControl.status));
  $('#saveNote').disabled = busy || !state.connected || (typed && !state.selectedModel?.available) || !hasContent || (!typed && Boolean(card?.notice));
  $('#syncNote').disabled = Boolean(noteInput?.hasSources) || Boolean(card?.localOnly && !typed) || busy || !state.connected || !state.selectedModel?.available || !hasContent || syncBlocked;
}
function updateSendAvailability() {
  $('#send').disabled = (state === conversations.aksignal && !latestMarketArtifact() && !state.marketArtifact) || state.turnActive || submitting || !state.connected || !state.selectedModel?.available;
  $('#previewPublication').disabled = state.turnActive || submitting || !state.connected || !runtimeSnapshot?.operations?.some(item=>item.workspace === 'publish' && item.requiresSnapshot && item.enabled);
  updateNoteActions();
}
function setConnection(connected, status = state.workerStatus) { for (const context of Object.values(conversations)) if (context) { context.connected = connected; context.workerStatus = status; } state.connected = connected; state.workerStatus = status; $("#connection").className = `connection ${connected ? "connected" : "disconnected"}`; $("#connection span").textContent = currentWorkspace === 'publish' ? (connected ? '已连接' : '连接中…') : `Mac Worker ${status === "BUSY" ? "Running" : connected ? "Online" : "Offline"}`; updateSendAvailability(); if (["fetch","knbase","miit"].includes(currentWorkspace)) renderIndependent(); }
function taskLabel(status) { return state === conversations.publish ? ({RUNNING:'正在整理',COMPLETED:'已完成',INTERRUPTED:'处理已中断',WAITING_PERMISSION:'等待确认'})[status] || TASK_LABELS[status] || status : TASK_LABELS[status] || status; }
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
function renderSession() {
  $("#sessionMeta").textContent = state.session ? `当前对话 · ${state.selectedModel ? modelLabel(state.selectedModel) : "选择执行模型"}` : "正在创建对话…";
  if (currentWorkspace === 'publish' && state.session) {
    const url = new URL(location.href); url.searchParams.set('workspace', 'publish'); url.searchParams.set('conversation', state.session.id);
    history.replaceState(null, '', url);
  }
}
function renderMessage(item) {
  if (item.role === "user") return `<div class="message user"><div class="label">任务描述</div><div class="bubble">${escapeHTML(item.text)}</div></div>`;
  if (item.kind === 'result' && item.contentCard) return `<article class="history-result">${contentCardHTML(item.contentCard, true)}</article>`;
  if (item.kind === 'result') return `<article class="history-result"><div class="history-result-head"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(TASK_LABELS[item.status] || item.status)}</span></div><div>${item.plainText ? `<pre>${escapeHTML(item.text)}</pre>` : markdown(item.text)}</div>${(item.artifacts || []).map(artifact => `<div class="history-attachment"><span>${escapeHTML(artifact.name)}</span><a href="${artifactURL('/api/artifacts/content', artifact.artifactId)}" target="_blank" rel="noopener">查看附件</a><a href="${artifactURL('/api/artifacts/download', artifact.artifactId)}" download>下载</a></div>`).join('')}</article>`;
  if (state === conversations.publish && item.kind === "process") return '';
  if (item.kind === "notice") return `<div class="message assistant notice ${escapeHTML(item.level || "info")}"><div class="label">任务提示</div><div class="bubble">${escapeHTML(item.text)}</div></div>`;
  const steps = (item.steps || []).map((step) => `<li class="step ${escapeHTML(step.status)}"><span class="step-dot"></span><span>${escapeHTML(step.label)}</span></li>`).join("");
  const meta = item.model ? `<div class="message-meta">${escapeHTML(item.model.label || item.model.modelID || "OpenCode")}</div>` : "";
  return `<div class="message assistant process"><div class="label">Assistant</div><ul class="process-steps">${steps}</ul>${meta}</div>`;
}
function permissionHTML() {
  const pending = state.pendingPermission;
  const request = pending.request || {};
  const labels = { external_directory: '访问项目外目录', read: '读取文件', bash: '执行命令', write: '写入文件' };
  const scope = request.patterns?.join('\n') || request.metadata?.filepath || request.permission || '工具操作';
  return `<div class="permission tool-permission" role="alert" aria-live="assertive"><strong>任务暂停 · 需要你的授权</strong><p>${escapeHTML(labels[request.permission] || request.permission || 'OpenCode 请求执行工具')}</p><pre>${escapeHTML(scope)}</pre><p>等待审批期间暂停执行计时。允许一次只批准当前请求，后续请求会再次提示。</p>${pending.error ? `<p role="alert">${escapeHTML(pending.error)}</p>` : ''}<div class="permission-actions"><button data-choice="once" ${pending.submitting ? 'disabled' : ''}>${pending.submitting ? '正在等待执行端确认…' : '允许本次并继续'}</button><button data-choice="always" ${pending.submitting ? 'disabled' : ''}>始终允许此范围</button><button data-choice="reject" ${pending.submitting ? 'disabled' : ''}>拒绝</button></div></div>`;
}

function renderMessages() {
  const container = $("#messages");
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const copy = state === conversations.publish ? contentCopy[state.contentMode || 'notes'] : workspaceCopy[state === conversations.aksignal ? 'aksignal' : 'service'];
  const body = state.messages.length ? state.messages.map(renderMessage).join("") : `<div class="welcome"><img class="avatar" src="/raccoon.png" width="42" height="42" alt="mashang" /><h2>${copy.welcome}</h2><p>${copy.description}</p></div>`;
  const reply = $("#resultBody");
  reply.remove();
  container.innerHTML = body + (state.pendingPermission ? permissionHTML() : "");
  container.append(reply);
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
function renderResult(text, plainText = false) { const content = typeof state !== 'undefined' && typeof conversations !== 'undefined' && state === conversations.publish; const card = content && state.contentCard; const publicationDraft = content && !card && text && !state.operationControl && /微博/.test(state.taskTitle || ''); $("#resultContent").innerHTML = card ? contentCardHTML(card, (state.contentMode || 'notes') === 'notes') : text ? (plainText ? `<pre style="white-space:pre-wrap">${escapeHTML(text)}</pre>` : markdown(text)) : ''; if (publicationDraft) $("#resultContent").innerHTML += '<div class="content-actions"><button type="button" class="quiet" data-draft-action="edit">修改</button><button type="button" class="content-primary" data-draft-action="publish">预览并发布</button></div>'; }
function artifactCandidates(text = "") { const pattern = /(?:^|[\s"'`(])((?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_.-]+\.(?:md|html|csv|png))(?=$|[\s"'`),.;])/gu; return [...text.matchAll(pattern)].map((match) => match[1]); }
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function artifactURL(endpoint, artifactId) { return `${endpoint}?artifactId=${encodeURIComponent(artifactId)}`; }
function ensureArtifactMount() { let box = optional("#artifacts"); if (!box) { box = document.createElement("div"); box.id = "artifacts"; box.className = "artifacts hidden"; $("#resultBody").append(box); } return box; }
function renderArtifacts() {
  let box = optional("#artifacts");
  if (!state.artifacts.length) { if (box) { box.classList.add("hidden"); box.innerHTML = ""; } return; }
  box = box || ensureArtifactMount();
  box.classList.remove("hidden");
  box.innerHTML = `<div class="artifacts-title"><span>${isTerminalState() && state.taskState !== 'COMPLETED' ? '已生成的部分产物 · 任务未完成' : '任务附件'}</span><small>${state.artifacts.length} 个文件</small></div>${state.artifacts.map((artifact, index) => `<div class="artifact-card" data-index="${index}"><div class="artifact-icon artifact-${artifact.extension.slice(1)}">${artifact.extension.slice(1).toUpperCase()}</div><div class="artifact-info"><strong>${escapeHTML(artifact.name)}</strong><span>${escapeHTML(artifact.artifactType || ({".md":"Markdown",".html":"HTML",".csv":"CSV",".png":"图片"})[artifact.extension] || "附件")} · ${formatBytes(artifact.size)}</span><small title="${escapeHTML(artifact.path || artifact.name)}">${escapeHTML(artifact.path || "Local artifact")}</small></div><div class="artifact-actions">${artifact.extension === ".csv" ? "" : `<button data-action="preview">预览</button>`}<a class="artifact-download" href="${artifactURL("/api/artifacts/download", artifact.artifactId)}" download>下载</a></div>${artifact.preview ? `<div class="artifact-preview">${artifact.preview}</div>` : ""}</div>`).join("")}`;
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
$("#messages").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-choice]");
  const context = state, pending = context.pendingPermission;
  if (!button || !pending || pending.submitting || !pending.id) return;
  pending.submitting = true; pending.error = null; renderMessages();
  try {
    await api(`/api/permissions/${encodeURIComponent(pending.id)}/reply`, { method: "POST", body: JSON.stringify({ response: button.dataset.choice }) });
    resolvePermission(context, pending.id);
  } catch (error) {
    if (context.pendingPermission?.id === pending.id) { pending.submitting = false; pending.error = `审批未完成：${error.message}`; }
  }
  if (state === context) renderMessages();
});
function resolvePermission(context, id) {
  context.permissionQueue = (context.permissionQueue || []).filter(item => item.id !== id);
  if (context.pendingPermission?.id !== id) return;
  context.pendingPermission = context.permissionQueue[0] || null;
  if (state === context) {
    if (!isTerminalState()) { context.taskState = context.pendingPermission ? 'WAITING_PERMISSION' : 'RUNNING'; setStatus(context.taskState, context.pendingPermission ? '等待你的授权' : '审批已确认，继续执行'); }
    renderMessages();
  } else if (!['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED'].includes(context.taskState)) {
    context.taskState = context.status = context.pendingPermission ? 'WAITING_PERMISSION' : 'RUNNING';
  }
}

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
  const defaultModel = selectAvailableModel(models, state.selectedModel);
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
  const savedID = context === conversations.publish && linkedContentSession ? linkedContentSession : localStorage.getItem(sessionStorageKey(context));
  context.session = sessions.find?.((item) => item.id === savedID);
  if (context === conversations.publish && linkedContentSession && !context.session) throw new Error('链接中的 Content 会话不存在，请检查 Hub 地址。');
  if (!context.session) context.session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "mashang-hub" }) });
  localStorage.setItem(sessionStorageKey(context), context.session.id);
  if (state === context) { renderSession(); renderDebug(); }
  const latest = (await api('/api/tasks')).find(task => task.source === 'conversation' && task.conversationId === context.session.id );
  if (context === conversations.publish) {
    const controls = await api('/api/runtime/controls');
    const control = controls.filter(item => item.snapshotRef && item.conversationId === context.session.id && (!item.originTaskId || item.originTaskId === latest?.taskId)).sort((a,b)=>b.createdAt-a.createdAt)[0];
    if (control) {
      context.operationControl = control;
      try {
        const preview = await api(`/api/runtime/controls/${encodeURIComponent(control.controlId)}/preview`);
        context.assistantText = preview.text; context.contentCard = preview.contentCard; context.resultPlainText = !preview.contentCard; context.reviewedDigest = preview.digest;
      } catch { context.assistantText = '内容暂时无法读取，请连接恢复后再查看。'; }
      if (state === context) renderConversation();
    }
  }
  if (context === conversations.publish && latest?.resultPreview) {
    try { const preview = await api(`/api/tasks/${encodeURIComponent(latest.taskId)}/preview`); context.contentCard = preview.contentCard; context.assistantText = preview.text; if(state === context) renderConversation(); } catch {}
  }
  if (latest && !context.activeTaskId) {
    context.activeTaskId = latest.taskId; context.turnId = latest.turnId;
    context.taskState = latest.legacyStatus === 'TIMEOUT' ? 'TIMEOUT' : latest.status === 'DISPATCHED' ? 'SUBMITTING' : latest.status === 'UNCERTAIN' ? 'INTERRUPTED' : latest.status;
    context.turnActive = ['RUNNING', 'DISPATCHED'].includes(latest.status);
    context.startedAt = latest.startedAt; context.finishedAt = latest.finishedAt;
    const label = latest.status === 'UNCERTAIN' ? '结果待核对，禁止自动重试' : latest.status === 'INTERRUPTED' ? '等待 Worker 执行对账' : context.turnActive ? '正在核对任务执行状态' : taskLabel(context.taskState);
    if (!context.messages.length) context.messages.push({ role:'assistant', kind:'process', steps:[{label, status:processStepStatus(context.taskState)}] });
    if (state === context) { setStatus(context.taskState, label); renderMessages(); }
    updateCancelVisibility();
  }
  if (latest) { context.artifacts = (await api(`/api/tasks/${encodeURIComponent(latest.taskId)}/artifacts`)).map(a => ({...a, preview:''})); if (state === context) renderArtifacts(); }
  for (const permission of await api('/api/permissions')) if (permission.taskId === context.activeTaskId) handleServerEvent(permission);
  if (context === conversations.publish) await syncContentConversation();
}
// Content clients share task identity. Polling repairs missed SSE events without
// replaying prompts or storing note bodies in the browser as authoritative state.
async function syncContentConversation() {
  const context = conversations.publish;
  if (!context?.session || contentSyncing || submitting) return;
  contentSyncing = true;
  const sessionId = context.session.id;
  const revision = context.syncRevision || 0;
  try {
    const latest = (await api('/api/tasks')).find(task => task.source === 'conversation' && task.conversationId === sessionId && task.workspaceId === 'publish');
    if (!latest) return;
    const result = latest.hasText && context.loadedResultTaskId !== latest.taskId ? await api(`/api/tasks/${encodeURIComponent(latest.taskId)}/result`) : null;
    const control = (await api('/api/runtime/controls')).filter(item => item.conversationId === sessionId && item.originTaskId === latest.taskId).sort((a,b) => b.createdAt - a.createdAt)[0];
    const preview = control?.status === 'PENDING_APPROVAL' && context.reviewedDigest !== control.digest
      ? await api(`/api/runtime/controls/${encodeURIComponent(control.controlId)}/preview`) : null;
    if (context.session?.id !== sessionId || submitting || (context.syncRevision || 0) !== revision) return;
    if (context.activeTaskId !== latest.taskId) {
      if (context.assistantText) context.messages.push({ role:'assistant', kind:'result', text:context.assistantText, contentCard:context.contentCard, status:context.taskState, title:context.taskTitle, artifacts:context.artifacts });
      Object.assign(context, { activeTaskId:latest.taskId, turnId:latest.turnId, assistantText:'', contentCard:null, pendingContentAction:null, operationControl:null, reviewedDigest:null, artifacts:[], pendingPermission:null, permissionQueue:[], taskTitle:'Content', loadedResultTaskId:null });
    }
    context.taskState = latest.legacyStatus || latest.status;
    context.status = context.taskState;
    context.turnActive = ['CREATED','DISPATCHED','SUBMITTING','RUNNING'].includes(latest.status);
    context.startedAt = latest.startedAt; context.finishedAt = latest.finishedAt;
    if (result) { context.assistantText = result.text; context.contentCard = result.contentCard; context.resultPlainText = result.plainText; context.loadedResultTaskId = latest.taskId; }
    if (control) context.operationControl = control;
    if (preview) { context.assistantText = preview.text; context.contentCard = preview.contentCard; context.reviewedDigest = preview.digest; }
    if (context === state) renderConversation();
  } catch { /* The next snapshot can repair a missed result after reconnection. */ }
  finally { contentSyncing = false; }
}
function parseMessage(data) { return (data?.parts || []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n"); }
function actualModel(info) { const modelID = info?.modelID || info?.model?.id; const providerID = info?.providerID || info?.model?.providerID; const known = state.models?.find((model) => model.modelID === modelID && model.providerID === providerID); return { label: known ? modelLabel(known) : modelID ? `${providerID || ""}/${modelID}` : "Unknown model", modelID, providerID, cost: info?.cost, tokens: info?.tokens }; }
async function directContentAuthorization(text) {
  if (!globalThis.crypto?.subtle) return null;
  const match = /^(?:请)?直接同步(?:到)?\s*Flomo\s*[：:]([\s\S]+)$/i.exec(text);
  const source = match?.[1] || (/^(?:请)?直接同步(?:到)?\s*Flomo[。！!\s]*$/i.test(text) ? state.contentCard?.text : null);
  if (!source) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(source)));
  return { targetId: 'notes-flomo', sourceDigest: [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('') };
}
async function sendPrompt(text, publicationPreview = false, contentAction = null, media = {}) {
  if (state.turnActive || submitting) return;
  if(state === conversations.aksignal && !bindMarket()) throw new Error("暂无可引用的正式日报");
  submitting = true;
  state.syncRevision = (state.syncRevision || 0) + 1;
  if (state.activeTaskId) state.messages.push({ role:'assistant',kind:'result',text:state.assistantText,status:state.taskState,title:state.taskTitle,plainText:state.resultPlainText,contentCard:state.contentCard,artifacts:state.artifacts.map(item=>({...item})) });
  state.taskTitle = text.trim().slice(0, 48); state.resultPlainText = false; state.startedAt = Date.now(); state.finishedAt = null;
  state.messages.push({ role: "user", text });
  state.contentCard = null; state.pendingContentAction = null;
  state.assistantText = ""; state.artifactScanText = ""; state.artifacts = [];
  state.activeTaskId = null; state.taskState = "UNDERSTANDING"; state.turnActive = true; state.pendingPermission = null; state.permissionQueue = [];
  renderMessages(); renderResult(""); renderArtifacts(); setStatus("UNDERSTANDING"); updateCancelVisibility(); $("#send").disabled = true;
  try {
    if (!state.session) await ensureSession();
    if(state === conversations.aksignal) {bindMarket();renderMarketBinding();}
    if (!publicationPreview && !['save','save-input','edit-save','edit'].includes(contentAction?.action) && !state.selectedModel?.available) throw new Error("请选择可用模型");
    state.operationControl = null; renderPublication();
    const scopedAuthorization = state === conversations.publish ? await directContentAuthorization(text) : null;
    const response = await api(`/api/sessions/${encodeURIComponent(state.session.id)}/message`, { method: "POST", body: JSON.stringify({ model: state.selectedModel ? { providerID: state.selectedModel.providerID, modelID: state.selectedModel.modelID } : null, workspaceId: state === conversations.aksignal ? "aksignal" : state === conversations.publish ? "publish" : null, ...media, contentAction, scopedAuthorization, marketArtifactId: state === conversations.aksignal ? state.marketArtifact?.artifactId : undefined, parts: [{ type: "text", text }], confirmationId: state.confirmationId }) });
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
  state.turnActive = false; state.pendingPermission = null; state.permissionQueue = []; renderMessages();
  renderResult("");
  updateCancelVisibility(); updateSendAvailability();
}
function showPermission(request) {
  if (isTerminalState() || !request.id) return;
  state.permissionQueue ||= [];
  if (!state.permissionQueue.some(item => item.id === request.id)) state.permissionQueue.push(request);
  state.pendingPermission = state.permissionQueue[0];
  state.taskState = 'WAITING_PERMISSION';
  setStatus('WAITING_PERMISSION', '任务暂停，等待你的授权'); renderMessages();
  document.querySelector('.tool-permission')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function handleServerEvent(event) {
  const contentContext = conversations.publish;
  if (contentContext && (event.taskId === contentContext.activeTaskId || event.sessionId === contentContext.session?.id || event.conversationId === contentContext.session?.id))
    contentContext.syncRevision = (contentContext.syncRevision || 0) + 1;
  if (event.type === 'task.created') { syncContentConversation(); return; }
  if (event.type === 'runtime.control.updated' && event.snapshotRef) {
    const context = Object.values(conversations).find(item => item?.session?.id === event.conversationId);
    if (context && (!event.originTaskId || !context.activeTaskId || context.activeTaskId === event.originTaskId) && (!context.operationControl || context.operationControl.controlId === event.controlId || event.status === 'PENDING_APPROVAL')) context.operationControl = event;
    renderPublication(); refreshExecutionInfo(); updateNoteActions();
  }
  if (event.type === "permission.requested" && !event.taskId && event.request?.sessionID) {
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
  if (event.type === 'permission.resolved') { for (const item of [...(state.permissionQueue || [])]) if (!event.requestId || item.id === event.requestId) resolvePermission(state, item.id); return; }
  if (event.type === "runtime.snapshot" || event.type === "runtime.control.permission.requested" || event.type === "runtime.control.updated") { runtimeUI.update(event); if (event.type === "runtime.snapshot") { runtimeSnapshot = event.snapshot; updateSendAvailability(); if(currentWorkspace === "aksignal") renderMarketBinding(); if (["fetch","knbase","miit"].includes(currentWorkspace)) renderIndependent(); } return; }
  if (event.type === "worker.status") { state.models = event.models || state.models; for (const context of Object.values(conversations)) if (context) context.models = state.models; if (event.models) renderModelOptions(event.models); setConnection(["ONLINE", "BUSY"].includes(event.status), event.status); return; }
  if (event.type === "session.mapped") { state.openCodeSessionId = event.openCodeSessionId; renderDebug(); return; }
  if (event.type === "task.timeout.warning") { if (!isTerminalState()) { setStatusLabel("运行超时，正在尝试取消"); updateRunningLabel("运行超时，正在尝试取消"); } return; }
  if (event.type === 'task.resumed' && event.taskId === state.activeTaskId) { applyTaskEvent(event.taskId, 'task.resumed'); state.turnActive = true; pushProcessNote('已核对 Worker 执行，任务继续运行'); return; }
  if (event.type === 'task.progress.stalled' && event.taskId === state.activeTaskId) { pushProcessNote(event.error); return; }
  if (event.type === "task.accepted") { applyTaskEvent(event.taskId, "task.accepted"); return; }
  if (event.type === "task.running") { if (!state.pendingPermission) applyTaskEvent(event.taskId, "task.running"); return; }
  if (event.type === "agent.message.delta" && event.taskId === state.activeTaskId) { state.assistantText += event.text || ""; updateRunningLabel("正在生成结果"); return; }
  if (event.type === "agent.message.completed" && event.taskId === state.activeTaskId) { applyTaskEvent(event.taskId, "agent.message.completed"); if (Object.hasOwn(event, "confirmationId")) state.confirmationId = event.confirmationId; if(event.contentCard) state.contentCard = event.contentCard; if(event.operationControl) state.operationControl = event.operationControl; completeAssistant(event.text || state.assistantText, event.actualModel, event.plainText === true); if (event.operationControl) { state.operationControl = event.operationControl; state.reviewedDigest = event.operationControl.digest; renderPublication(); } return; }
  if (event.type === "task.completed") {
    if (state === conversations.publish && state.mediaSubmission && state.contentCard?.localOnly && state.contentCard.notice) {
      if (currentWorkspace === 'publish' && $('#prompt').value === state.mediaSubmission.text) $('#prompt').value = '';
      if (state.draft === state.mediaSubmission.text) state.draft = '';
      state.mediaSubmission = null; noteInput.clear(); autosizePrompt();
    }
    state.finishedAt = Date.now(); if (applyTaskEvent(event.taskId, "task.completed")) state.turnActive = false; updateSendAvailability(); return; }
  if (["task.failed", "task.timeout", "task.cancelled", "task.interrupted"].includes(event.type)) { handleTerminal(event); return; }
  if (event.type === "artifact.created" && event.taskId === state.activeTaskId) { state.artifacts = [...state.artifacts.filter((artifact) => artifact.artifactId !== event.artifactId), { ...event, preview: "" }]; renderArtifacts(); pushProcessNote(`已生成 ${event.name || event.path || "文件"}`); return; }
  if (event.type === "permission.requested") { showPermission({ id: event.requestId, request: event.request || {} }); return; }
}
function connectEvents() { const stream = new EventSource("/api/events"); stream.addEventListener("mashang", (message) => handleServerEvent(JSON.parse(message.data))); stream.onerror = () => { setConnection(false, "OFFLINE"); setTimeout(connectEvents, 2500); stream.close(); }; }

optional("#cancel")?.addEventListener("click", async () => { if (!state.activeTaskId || isTerminalState()) return; try { await api(`/api/tasks/${encodeURIComponent(state.activeTaskId)}/cancel`, { method: "POST" }); if (!isTerminalState()) { setStatusLabel("正在取消…"); updateRunningLabel("正在取消…"); } } catch (error) { setStatusLabel(`取消失败：${error.message}`); } });
function autosizePrompt() { const input = optional("#prompt"); if (!input) return; input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
function syncKeyboardInset() { const vv = window.visualViewport; if (!vv) return; const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)); document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`); document.body.classList.toggle("keyboard-open", inset > 80); }
const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
noteInput = createNoteInput({ input: $('#prompt'), panel: $('#noteInputPanel'), picker: $('#noteImageFiles'), button: $('#addNoteImage'), list: $('#noteAttachmentList'), status: $('#noteInputStatus'),
  active: () => currentWorkspace === 'publish' && (state.contentMode || 'notes') === 'notes',
  busy: () => Boolean(conversations.publish?.turnActive || submitting),
  changed: () => {
    if (noteInput?.count && state === conversations.publish && !state.selectedModel?.imageInput) {
      const vision = state.models.find(model => model.available && model.imageInput);
      if (vision) { state.selectedModel = vision; renderModelOptions(state.models); pushNotice(`已切换到支持图片的 ${vision.label}`); }
    }
    autosizePrompt(); updateNoteActions();
  }, notice: message => pushNotice(message) });
$("#promptForm").addEventListener("submit", (event) => { event.preventDefault(); if (currentWorkspace === 'publish' && (state.contentMode || 'notes') === 'notes') { $('#saveNote').click(); return; } const input = $("#prompt"); const text = input.value; if (!text.trim() || $("#send").disabled) return; input.value = ""; autosizePrompt(); sendPrompt(text, false, state.pendingContentAction).catch((error) => { state.taskState = "FAILED"; state.turnActive = false; setStatus("FAILED", `任务提交失败：${error.message}`); pushNotice(`无法提交任务：${error.message}`); }); });
function editCurrentNote(force = false) {
  const input = $('#prompt');
  if (force || !input.value.trim()) {
    input.value = state.contentCard?.text || state.assistantText || '';
    state.pendingContentAction = state.contentCard ? { ref: state.contentCard.ref, action: 'edit' } : null;
  }
  invalidatePublicationApproval(); autosizePrompt(); updateNoteActions(); input.focus();
}
$('#noteComposerActions').addEventListener('click', event => {
  const button = event.target.closest('[data-note-compose]');
  if (!button || button.disabled || state.turnActive || submitting) return;
  const action = button.dataset.noteCompose;
  const input = $('#prompt');
  const media = noteInput.snapshot();
  const hasMedia = noteInput.hasSources;
  const typed = Boolean(input.value.trim()) || hasMedia;
  const text = typed ? input.value : state.contentCard?.text || state.assistantText;
  if (!text?.trim() && !media.attachments.length) return;
  if (hasMedia && action !== 'save') return;
  const pending = state.pendingContentAction;
  const request = hasMedia ? { action: 'save-input' } : typed && pending?.action === 'edit' ? { ref: pending.ref, action: `edit-${action}` }
    : !typed && state.contentCard ? { ref: state.contentCard.ref, action }
    : { action: `${action}-input` };
  if (hasMedia) state.mediaSubmission = { text: input.value };
  else input.value = '';
  autosizePrompt();
  sendPrompt(text || '', false, request, media).catch(() => pushNotice('操作未完成，请检查后再试。'));
});
$('#resultContent').addEventListener('click', event => {
  const draftAction = event.target.closest('[data-draft-action]')?.dataset.draftAction;
  if (draftAction && !state.turnActive && !submitting) {
    if (draftAction === 'edit') { $('#prompt').value = state.assistantText; autosizePrompt(); $('#prompt').focus(); }
    else sendPrompt(`发布微博[${$('#publicationVisibility').value},${$('#publicationStatement').value}]：${state.assistantText}`, true).catch(() => pushNotice('预览暂时不可用，请稍后再试。'));
    return;
  }
  const button = event.target.closest('[data-content-action]');
  const card = state.contentCard;
  if (!button || !card || state.turnActive || submitting) return;
  const action = button.dataset.contentAction;
  if (action === 'edit') {
    editCurrentNote(true); return;
  }
  button.disabled = true;
  sendPrompt(button.textContent, false, { ref: card.ref, action }).catch(() => pushNotice('操作未完成，请检查后再试。'));
});
$('#previewPublication').addEventListener('click', () => {
  if (state !== conversations.publish || state.turnActive || submitting || !state.connected) return;
  const text = $('#prompt').value;
  if (!text.trim()) return;
  sendPrompt(`发布微博[${$("#publicationVisibility").value},${$("#publicationStatement").value}]：${text}`, true).catch(error => { state.turnActive = false; state.taskState = 'FAILED'; setStatus('FAILED'); updateSendAvailability(); pushNotice(error.message); });
});
function invalidatePublicationApproval() {
  const control = state.operationControl;
  if (control?.status === 'PENDING_APPROVAL') {
    state.reviewedDigest = null; control.status = 'CANCELLED'; renderPublication();
    api(`/api/runtime/controls/${encodeURIComponent(control.controlId)}/cancel`, {method:'POST'}).catch(error => pushNotice(error.message));
  }
}
$('#prompt').addEventListener('input', () => { autosizePrompt(); invalidatePublicationApproval(); updateNoteActions(); });
for (const id of ['publicationVisibility','publicationStatement']) $('#'+id).addEventListener('change', invalidatePublicationApproval);
$("#prompt").addEventListener("keydown", (event) => { if (event.key !== "Enter") return; if (coarsePointer && !event.metaKey && !event.ctrlKey) return; if (!event.shiftKey) { event.preventDefault(); $("#promptForm").requestSubmit(); } });
if (window.visualViewport) { visualViewport.addEventListener("resize", syncKeyboardInset); visualViewport.addEventListener("scroll", syncKeyboardInset); }
window.addEventListener("orientationchange", () => setTimeout(syncKeyboardInset, 300));
autosizePrompt();
$('#newSession').addEventListener('click', async () => {
  if (state.turnActive || submitting) return;
  submitting = true; updateSendAvailability();
  try {
    state.contentCard = null; state.pendingContentAction = null;
    state.session = await api('/api/sessions', { method:'POST', body:JSON.stringify({title:'mashang-hub'}) });
    if (state === conversations.publish) { state.mediaSubmission = null; noteInput.clear(); }
    localStorage.setItem(sessionStorageKey(), state.session.id);
    Object.assign(state, {messages:[],artifacts:[],artifactScanText:'',activeTaskId:null,taskState:'IDLE',turnId:null,openCodeSessionId:null,turnActive:false,pendingPermission:null,confirmationId:null,operationControl:null,earlyEvents:[],marketArtifact:null,taskTitle:null,draft:'',assistantText:'',resultPlainText:false,startedAt:null,finishedAt:null});
    $('#prompt').value = ''; renderConversation(); renderMarketBinding(); autosizePrompt();
  } catch (error) { pushNotice(`无法创建新对话：${error.message}`); }
  finally { submitting = false; updateSendAvailability(); }
});

optional("#debugToggle")?.addEventListener("click", () => optional("#debug")?.classList.toggle("hidden")); optional("#debugClose")?.addEventListener("click", () => optional("#debug")?.classList.add("hidden"));
const runtimeUI = initRuntimeUI();
async function initialize() { const response = await fetch("/api/auth/status"); const auth = await response.json(); if (auth.required && !auth.authenticated) { showLogin(); return; } if (linkedContentSession) switchWorkspace("publish"); setStatus("IDLE"); renderDebug(); updateCancelVisibility(); loadModels(); refreshConnection().then(() => ensureSession().catch(() => {})); fetch("/api/runtime").then(response=>response.json()).then(data=>{ runtimeSnapshot = data.snapshot; updateSendAvailability(); if (["fetch","knbase","miit"].includes(currentWorkspace)) renderIndependent(); }).catch(()=>{}); renderMessages(); connectEvents(); }
initialize();
setInterval(() => { if (!document.hidden) syncContentConversation(); }, 4000);
