const SERVICE_STATES = {
  ONLINE: { label: "在线", cls: "online" },
  OFFLINE: { label: "离线", cls: "offline" },
  UNKNOWN: { label: "未知", cls: "unknown" },
};
const JOB_STATES = {
  COMPLETED: { label: "Completed", cls: "completed" },
  FAILED: { label: "Failed", cls: "failed" },
  RUNNING: { label: "Running", cls: "running" },
  UNKNOWN: { label: "Unknown", cls: "unknown" },
};
const OPERATION_STATES = {
  ...JOB_STATES,
  IDLE: { label: "尚未运行", cls: "unknown" },
  CANCELLED: { label: "已取消", cls: "failed" },
};
const CONTROL_STATES = {
  UNKNOWN: { label: '待核验', cls: 'unknown' },
  PENDING_APPROVAL: { label: '待审阅最终正文', cls: 'running' },
  APPROVED: { label: '已批准', cls: 'running' },
  INTERRUPTED: { label: "等待执行对账", cls: "unknown" },
  UNCERTAIN: { label: "结果待核对", cls: "unknown" },
  AWAITING_PERMISSION: { label: "待审批", cls: "running" },
  RUNNING: { label: "执行中", cls: "running" },
  COMPLETED: { label: "完成", cls: "completed" },
  FAILED: { label: "失败", cls: "failed" },
  REFUSED: { label: "拒绝执行", cls: "failed" },
  REJECTED: { label: "已驳回", cls: "failed" },
  TIMEOUT: { label: "超时", cls: "failed" },
  CANCELLED: { label: "已取消", cls: "failed" },
};
const ACTIVE_CONTROL_STATUSES = new Set(["AWAITING_PERMISSION", "RUNNING"]);
const OP_PROGRESS = { up: "启动中…", down: "停止中…", restart: "重启中…", run: "运行中…" };
const RECENT_LIMIT = 5;
const RECENT_MAX_AGE_MS = 30 * 60 * 1000;

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function stateOf(map, key) { return map[key] || map.UNKNOWN; }
function opLabel(op) { return ({ up: "Up", down: "Down", restart: "Restart", run: "Run" })[op] || op; }
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function formatClockTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/**
 * Read-only status plus permission-gated controls for the local runtime.
 * Status comes from GET /api/runtime + `runtime.snapshot`.
 * Controls are created via POST /api/runtime/control and approved with
 * POST /api/runtime/controls/:id/decision; live updates arrive over SSE.
 */
export function initRuntimeUI() {
  const conversationMount = document.getElementById("conversationRuntime");
  const independentMount = document.getElementById("independentRuntime");
  let workspace = "service";
  let controlError = "";
  let snapshot = null;
  let workerOnline = false;
  const controls = new Map();

  function targetLabel(targetId) {
    const service = (snapshot?.services || []).find((item) => item.id === targetId);
    if (service) return service.label || service.id;
    const job = (snapshot?.jobs || []).find((item) => item.id === targetId);
    if (job) return job.label || job.id;
    const operation = (snapshot?.operations || []).find((item) => item.id === targetId);
    if (operation) return operation.label || operation.id;
    return targetId;
  }
  function upsertControl(control) {
    if (!control?.controlId) return;
    const previous = controls.get(control.controlId) || {};
    const statusChanged = control.status !== undefined && control.status !== previous.status;
    controls.set(control.controlId, {
      ...previous,
      ...control,
      createdAt: control.createdAt ?? previous.createdAt ?? Date.now(),
      updatedAt: control.updatedAt ?? (statusChanged || previous.updatedAt === undefined ? Date.now() : previous.updatedAt),
    });
    if (controls.size > 12) {
      const oldest = [...controls.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
      if (oldest) controls.delete(oldest.controlId);
    }
  }

  function actionButtons(ops, targetId) {
    return ops.map((op) => `<button class="rt-btn" type="button" data-op="${op}" data-target="${escapeHTML(targetId)}">${opLabel(op)}</button>`).join("");
  }
  function serviceItem(service) {
    const state = stateOf(SERVICE_STATES, service.status);
    const online = service.status === "ONLINE";
    const openUrl = online && service.openUrl ? escapeHTML(service.openUrl) : null;
    const label = openUrl
      ? `<a class="rt-service-link" href="${openUrl}" target="_blank" rel="noopener noreferrer">${escapeHTML(service.label || service.id)}</a>`
      : escapeHTML(service.label || service.id);
    const openAction = openUrl ? `<a class="rt-btn" href="${openUrl}" target="_blank" rel="noopener noreferrer">Open</a>` : "";
    const actions = online
      ? `${openAction}${actionButtons(["restart", "down"], service.id)}`
      : service.status === "OFFLINE" ? actionButtons(["up"], service.id) : "";
    const summary = service.summary ? `<span class="rt-sub">${escapeHTML(service.summary)}</span>` : "";
    return `<li class="rt-item"><span class="rt-dot ${state.cls}" role="img" aria-label="${state.label}"></span><div class="rt-main"><strong>${label}</strong>${summary}</div><div class="rt-actions">${actions}</div></li>`;
  }
  const SNAPSHOT_MAX_AGE_MS = 60000;
  function snapshotStale() {
    const time = Date.parse(snapshot?.generatedAt);
    return !Number.isFinite(time) || Date.now() - time > SNAPSHOT_MAX_AGE_MS;
  }
  function workspaceServiceItem(service) {
    const stale = snapshotStale();
    const safe = workerOnline && !stale;
    const status = !workerOnline ? "Worker Offline" : stale ? "快照已过期" : service.status || "UNKNOWN";
    const online = safe && service.status === "ONLINE", offline = safe && service.status === "OFFLINE";
    let url = null; try { const candidate = new URL(service.openUrl); if (["http:","https:"].includes(candidate.protocol) && !candidate.username && !candidate.password) url = candidate; } catch {}
    const local = url && ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    const statusClass = online ? "online" : offline ? "offline" : "unknown";
    const main = online && url ? `<a class="rt-btn runtime-primary" href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">打开工作台 ↗</a>` : offline ? `<button class="rt-btn runtime-primary" data-op="up" data-target="${escapeHTML(service.id)}">启动服务</button>` : "";
    const secondary = online ? actionButtons(["restart","down"],service.id).replace('>Restart<','>重启服务<').replace('>Down<','>停止服务<') : "";
    const feedback = !workerOnline ? "Worker 离线，连接恢复后才能控制服务。" : stale ? "运行快照已过期，等待新状态后再操作。" : online ? url ? "服务探测通过，可在新窗口打开工作台。" : "服务探测通过，但 Worker 尚未提供工作台地址。" : offline ? "服务探测未通过，可请求启动或展开运行详情诊断。" : "服务状态未知，等待可靠状态后再操作。";
    return `<li class="workspace-service compact-service"><div class="runtime-section-head"><h2>服务控制</h2><span class="runtime-state ${statusClass}"><span class="runtime-status-dot" aria-hidden="true"></span>${escapeHTML(status)}</span></div><p class="runtime-feedback">${feedback}</p><div class="rt-actions workspace-service-actions">${main}${secondary}</div><details class="runtime-diagnostics"><summary>运行详情${offline ? " · 诊断" : ""}</summary><dl class="runtime-facts"><div><dt>Worker ID</dt><dd>${escapeHTML(snapshot?.workerId || "—")}</dd></div><div><dt>Runtime ID</dt><dd>${escapeHTML(service.id)}</dd></div><div><dt>快照时间</dt><dd>${escapeHTML(formatTime(snapshot?.generatedAt))}</dd></div><div><dt>入口端口</dt><dd>${escapeHTML(url ? url.port || (url.protocol === "https:" ? "443" : "80") : "未知")}</dd></div><div><dt>工作台地址</dt><dd>${escapeHTML(url?.href || "未提供")}</dd></div></dl><p>状态来自 Worker 探测。探测失败不能单凭此认定进程停止；Worker 在线也不代表业务服务在线。</p><p>${local ? "这是 Worker 本机地址，手机或其他设备需配置可达地址。" : "当前设备访问尚未验证。"}</p><button class="rt-btn" disabled>查看日志 · 浏览器接口未接入</button><p>可在 Worker 本机使用 mashang logs 查看日志。</p></details></li>`;
  }
  function jobItem(job) {
    const last = job.lastRun || {};
    const state = stateOf(JOB_STATES, last.status);
    const when = last.finishedAt || last.startedAt;
    const sub = when ? `${state.label} · ${escapeHTML(formatClockTime(when))}` : state.label;
    return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(job.label || job.id)}</strong><span class="rt-sub">${sub}</span></div><div class="rt-actions">${actionButtons(["run"], job.id)}</div></li>`;
  }
  function operationItem(operation) {
    const last = operation.lastRun || {};
    const state = stateOf(OPERATION_STATES, last.status);
    const when = last.finishedAt || last.startedAt;
    const detail = [
      state.label,
      when ? escapeHTML(formatClockTime(when)) : "",
      last.summary ? escapeHTML(last.summary) : "",
    ].filter(Boolean).join(" · ");
    const description = operation.description ? `<span class="rt-sub">${escapeHTML(operation.description)}</span>` : "";
    const actions = operation.enabled && !operation.requiresSnapshot ? actionButtons(["run"], operation.id) : "";
    return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(operation.label || operation.id)}</strong><span class="rt-sub">${detail}</span>${description}</div><div class="rt-actions">${actions}</div></li>`;
  }
  function controlItem(control) {
    const state = stateOf(CONTROL_STATES, control.status);
    const target = targetLabel(control.targetId);
    const targetOperation = (snapshot?.operations || []).find((item) => item.id === control.targetId);
    const active = ACTIVE_CONTROL_STATUSES.has(control.status);
    const title = control.status === "RUNNING"
      ? `${target} · ${OP_PROGRESS[control.op] || state.label}`
      : control.status === "AWAITING_PERMISSION" ? target : `${control.op} · ${target}`;
    const sub = control.status === "AWAITING_PERMISSION" ? "需要确认" : active ? "" : state.label;
    const reason = control.reason && control.status !== "COMPLETED" ? escapeHTML(control.reason) : "";
    const detail = [sub, reason, !active ? `历史操作 · ${formatTime(control.updatedAt || control.createdAt)}` : ""].filter(Boolean).join(" · ");
    let actions = "";
    if (control.status === "AWAITING_PERMISSION") {
      actions = `<button class="rt-btn allow" data-control="${escapeHTML(control.controlId)}" data-decision="approve">允许</button><button class="rt-btn reject" data-control="${escapeHTML(control.controlId)}" data-decision="reject">拒绝</button>`;
    } else if (control.status === "RUNNING" && targetOperation?.cancellationSupported !== false) {
      actions = `<button class="rt-btn" data-control="${escapeHTML(control.controlId)}" data-cancel="1">取消</button>`;
    }
    return `<li class="rt-item rt-control"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(title)}</strong>${detail ? `<span class="rt-sub">${detail}</span>` : ""}</div><div class="rt-actions">${actions}</div></li>`;
  }

  function render() {
    const controlList = [...controls.values()].sort((a,b)=>(b.createdAt || 0)-(a.createdAt || 0));
    const services = snapshot?.services || [];
    const jobs = snapshot?.jobs || [];
    const operations = snapshot?.operations || [];
    const mount = ["fetch", "knbase"].includes(workspace) ? independentMount : conversationMount;
    if (mount) {
      // Older Workers may omit workspace metadata. Only presentation uses these legacy IDs/groups.
      const belongs = item => (item.workspace || ({fetch:"fetch",myknbase:"knbase"})[item.id] || (item.group === "MASHANG-SERVICE" ? "service" : null)) === workspace;
      const entries = [...services.filter(belongs).map(mount === independentMount ? workspaceServiceItem : serviceItem), ...jobs.filter(belongs).map(jobItem), ...operations.filter(belongs).map(operationItem)];
      if (mount === independentMount) {
        const service = services.find(belongs);
        const badge = document.getElementById("independentStatus");
        const status = workerOnline ? stateOf(SERVICE_STATES, service?.status) : SERVICE_STATES.UNKNOWN;
        if (badge) { badge.textContent = workerOnline ? service?.status || "Unknown" : "Unknown"; badge.className = `runtime-state ${status.cls}`; }
      }
      const targetIds = new Set([...services, ...jobs, ...operations].filter(belongs).map(item=>item.id));
      const matching = controlList.filter(item=>targetIds.has(item.targetId));
      const actions = [...matching.filter(item=>ACTIVE_CONTROL_STATUSES.has(item.status)), ...matching.filter(item=>!ACTIVE_CONTROL_STATUSES.has(item.status) && Date.now()-(item.updatedAt ?? item.createdAt ?? 0)<=RECENT_MAX_AGE_MS).slice(0,RECENT_LIMIT)];
      const activeActions = actions.filter(item=>ACTIVE_CONTROL_STATUSES.has(item.status));
      const history = actions.filter(item=>!ACTIVE_CONTROL_STATUSES.has(item.status));
      const historyOpen = mount.querySelector(".runtime-history")?.open;
      const detailsOpen = mount.querySelector(".runtime-diagnostics")?.open;
      mount.innerHTML = (controlError ? `<p role="alert" class="rt-empty">${escapeHTML(controlError)}</p>` : "") + (mount === independentMount ? "" : `<div class="workspace-runtime-meta">运行节点 · ${escapeHTML(snapshot?.workerId || "Mac Worker")} · ${workerOnline ? "Worker 在线" : "Worker 离线"} · 快照 ${escapeHTML(formatTime(snapshot?.generatedAt))}</div>`)
        + (workspace === "publish" ? `<p class="rt-empty">${operations.some(item=>belongs(item) && item.requiresSnapshot) ? "发布审批与结果在对话中展示。" : "正式发布尚未接入：Worker 尚未注册快照发布能力。"}</p>` : `<ul class="rt-list">${entries.join("") || '<li class="rt-empty">尚无属于此工作空间的 Runtime 记录</li>'}</ul><p class="workspace-runtime-note ${mount === independentMount ? 'hidden' : ''}">服务状态来自 Worker 探测，不等于本设备可访问。Offline 表示探测未通过，不能单凭它认定进程已停止。日志目前可在 Worker 本机通过 mashang logs 查看。</p>`)
        + (activeActions.length ? `<ul class="rt-list rt-current-actions">${activeActions.map(controlItem).join("")}</ul>` : "")
        + (history.length ? `<details class="runtime-history"><summary>操作历史 · ${history.length}</summary><p>以下是已结束的操作记录，不代表当前服务状态。</p><ul class="rt-list">${history.map(controlItem).join("")}</ul></details>` : "");
      if (historyOpen && mount.querySelector(".runtime-history")) mount.querySelector(".runtime-history").open = true;
      if (detailsOpen && mount.querySelector(".runtime-diagnostics")) mount.querySelector(".runtime-diagnostics").open = true;
      if (actions.some(item=>item.status === "AWAITING_PERMISSION") && mount === conversationMount) mount.closest("details").open = true;
      if (!workerOnline || (mount === independentMount && snapshotStale())) for (const button of mount.querySelectorAll("button")) button.disabled = true;
    }
  }

  async function refresh() {
    try {
      const response = await fetch("/api/runtime", { headers: { accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        workerOnline = Boolean(data.workerOnline);
        snapshot = data.snapshot || null;
      }
    } catch { /* Keep the last known snapshot. */ }
    try {
      const response = await fetch("/api/runtime/controls", { headers: { accept: "application/json" } });
      if (response.ok) for (const control of await response.json()) upsertControl(control);
    } catch { /* Ignore control list refresh errors. */ }
    render();
  }

  function update(event) {
    if (event.type === "runtime.control.permission.requested") {
      upsertControl({ controlId: event.controlId, op: event.op, targetId: event.targetId, status: "AWAITING_PERMISSION" });
      render();
      return;
    }
    if (event.type === "runtime.control.updated") {
      upsertControl({ controlId: event.controlId, op: event.op, targetId: event.targetId, status: event.status, reason: event.reason, code: event.code });
      render();
      return;
    }
    workerOnline = Boolean(event.workerOnline);
    if (event.snapshot) snapshot = event.snapshot;
    render();
  }

  async function requestControl(op, targetId) {
    try {
      const response = await fetch("/api/runtime/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, targetId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { controlError = data.error || "运行控制请求失败"; render(); return; }
      controlError = "";
      upsertControl(data);
      render();
    } catch { controlError = "运行控制请求未送达，请检查连接"; render(); }
  }
  async function decide(controlId, approve) {
    try {
      await fetch(`/api/runtime/controls/${encodeURIComponent(controlId)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
    } catch { /* SSE will reconcile state. */ }
  }
  async function cancelControl(controlId) {
    try {
      await fetch(`/api/runtime/controls/${encodeURIComponent(controlId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" } });
    } catch { /* SSE will reconcile state. */ }
  }

  const handleClick = (event) => {
    const action = event.target.closest("[data-op]");
    if (action && (action.disabled || !workerOnline || (event.currentTarget === independentMount && snapshotStale()))) return;
    if (action) { requestControl(action.dataset.op, action.dataset.target); return; }
    const decision = event.target.closest("[data-decision]");
    if (decision) { decide(decision.dataset.control, decision.dataset.decision === "approve"); return; }
    const cancel = event.target.closest("[data-cancel]");
    if (cancel) cancelControl(cancel.dataset.control);
  };
  for (const mount of [conversationMount, independentMount].filter(Boolean)) mount.addEventListener("click", handleClick);
  const interval = window.setInterval(refresh, 15000);
  refresh();

  return { update, refresh, setWorkspace(kind) { workspace = kind; render(); }, destroy: () => clearInterval(interval) };
}
