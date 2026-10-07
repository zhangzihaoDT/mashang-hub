const SERVICE_STATES = {
  ONLINE: { label: "在线", cls: "online" },
  OFFLINE: { label: "离线", cls: "offline" },
  UNKNOWN: { label: "未知", cls: "unknown" },
};
const DEPENDENCY_STATES = SERVICE_STATES;
const JOB_STATES = {
  COMPLETED: { label: "Completed", cls: "completed" },
  FAILED: { label: "Failed", cls: "failed" },
  RUNNING: { label: "Running", cls: "running" },
  UNKNOWN: { label: "Unknown", cls: "unknown" },
};
const CONTROL_STATES = {
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
  const panel = document.getElementById("runtime");
  const body = document.getElementById("runtimeBody");
  const meta = document.getElementById("runtimeMeta");
  const stateEl = document.getElementById("runtimeState");
  const workerIdEl = document.getElementById("runtimeWorkerId");
  const toggle = document.getElementById("runtimeToggle");
  const close = document.getElementById("runtimeClose");
  if (!panel || !body || !meta) return { update() {}, open() {} };

  let snapshot = null;
  let workerOnline = false;
  let receivedAt = null;
  const controls = new Map();

  function targetLabel(targetId) {
    const service = (snapshot?.services || []).find((item) => item.id === targetId);
    if (service) return service.label || service.id;
    const job = (snapshot?.jobs || []).find((item) => item.id === targetId);
    if (job) return job.label || job.id;
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
  function dependencyItem(dependency) {
    const state = stateOf(DEPENDENCY_STATES, dependency.status);
    return `<li class="rt-item"><span class="rt-dot ${state.cls}" role="img" aria-label="${state.label}"></span><div class="rt-main"><strong>${escapeHTML(dependency.label || dependency.id)}</strong></div></li>`;
  }
  function jobItem(job) {
    const last = job.lastRun || {};
    const state = stateOf(JOB_STATES, last.status);
    const when = last.finishedAt || last.startedAt;
    const sub = when ? `${state.label} · ${escapeHTML(formatClockTime(when))}` : state.label;
    return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(job.label || job.id)}</strong><span class="rt-sub">${sub}</span></div><div class="rt-actions">${actionButtons(["run"], job.id)}</div></li>`;
  }
  function controlItem(control) {
    const state = stateOf(CONTROL_STATES, control.status);
    const target = targetLabel(control.targetId);
    const active = ACTIVE_CONTROL_STATUSES.has(control.status);
    const title = control.status === "RUNNING"
      ? `${target} · ${OP_PROGRESS[control.op] || state.label}`
      : control.status === "AWAITING_PERMISSION" ? target : `${control.op} · ${target}`;
    const sub = control.status === "AWAITING_PERMISSION" ? "需要确认" : active ? "" : state.label;
    const reason = control.reason && control.status !== "COMPLETED" ? escapeHTML(control.reason) : "";
    const detail = [sub, reason].filter(Boolean).join(" · ");
    let actions = "";
    if (control.status === "AWAITING_PERMISSION") {
      actions = `<button class="rt-btn allow" data-control="${escapeHTML(control.controlId)}" data-decision="approve">允许</button><button class="rt-btn reject" data-control="${escapeHTML(control.controlId)}" data-decision="reject">拒绝</button>`;
    } else if (control.status === "RUNNING") {
      actions = `<button class="rt-btn" data-control="${escapeHTML(control.controlId)}" data-cancel="1">取消</button>`;
    }
    return `<li class="rt-item rt-control"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(title)}</strong>${detail ? `<span class="rt-sub">${detail}</span>` : ""}</div><div class="rt-actions">${actions}</div></li>`;
  }

  function render() {
    if (workerIdEl) workerIdEl.textContent = snapshot?.workerId || "Worker";
    if (stateEl) {
      stateEl.textContent = workerOnline ? "Worker 在线" : "Worker 离线";
      stateEl.className = `runtime-state ${workerOnline ? "online" : "offline"}`;
    }
    meta.textContent = `快照 ${formatTime(snapshot?.generatedAt)} · 接收 ${formatTime(receivedAt)}`;

    const sections = [];
    const controlList = [...controls.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const activeControls = controlList.filter((control) => ACTIVE_CONTROL_STATUSES.has(control.status));
    const now = Date.now();
    const recentControls = controlList
      .filter((control) => !ACTIVE_CONTROL_STATUSES.has(control.status))
      .filter((control) => now - (control.updatedAt ?? control.createdAt ?? 0) <= RECENT_MAX_AGE_MS)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, RECENT_LIMIT);
    const services = snapshot?.services || [];
    const dependencies = snapshot?.dependencies || [];
    const jobs = snapshot?.jobs || [];
    const workerStatus = workerOnline ? "ONLINE" : "OFFLINE";
    const workerState = stateOf(SERVICE_STATES, workerStatus);
    sections.push(`<div class="rt-group"><h3>Worker</h3><ul class="rt-list"><li class="rt-item"><span class="rt-dot ${workerState.cls}" role="img" aria-label="${workerState.label}"></span><div class="rt-main"><strong>${escapeHTML(snapshot?.workerId || "Worker")}</strong></div></li></ul></div>`);
    if (!snapshot) {
      sections.push(`<div class="rt-empty">暂无 Runtime 快照。Worker 连接后会自动上报。</div>`);
    } else {
      sections.push(`<div class="rt-group"><h3>Dependencies</h3><ul class="rt-list">${dependencies.map(dependencyItem).join("") || `<li class="rt-item"><div class="rt-main"><span class="rt-sub">无</span></div></li>`}</ul></div>`);
      if (activeControls.length) sections.push(`<div class="rt-group rt-active-controls"><h3>Control</h3><ul class="rt-list">${activeControls.map(controlItem).join("")}</ul></div>`);
      const groupedEntries = new Map();
      function addEntry(group, kind, item) {
        if (!groupedEntries.has(group)) groupedEntries.set(group, []);
        groupedEntries.get(group).push({ kind, item });
      }
      for (const service of services) addEntry(service.group || "Services", "service", service);
      for (const job of jobs) addEntry(job.group || "Jobs", "job", job);
      for (const [group, entries] of groupedEntries) {
        const items = entries.map(({ kind, item }) => kind === "service" ? serviceItem(item) : jobItem(item)).join("");
        sections.push(`<div class="rt-group"><h3>${escapeHTML(group)}</h3><ul class="rt-list">${items}</ul></div>`);
      }
    }
    if (recentControls.length) sections.push(`<details class="rt-recent"><summary>Recent actions <span>${recentControls.length}</span></summary><ul class="rt-list">${recentControls.map(controlItem).join("")}</ul></details>`);
    body.innerHTML = sections.join("");
  }

  async function refresh() {
    try {
      const response = await fetch("/api/runtime", { headers: { accept: "application/json" } });
      if (response.ok) {
        const data = await response.json();
        workerOnline = Boolean(data.workerOnline);
        receivedAt = data.receivedAt || null;
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
      open();
      render();
      return;
    }
    if (event.type === "runtime.control.updated") {
      upsertControl({ controlId: event.controlId, op: event.op, targetId: event.targetId, status: event.status, reason: event.reason, code: event.code });
      render();
      return;
    }
    workerOnline = Boolean(event.workerOnline);
    if (event.receivedAt) receivedAt = event.receivedAt;
    if (event.snapshot) snapshot = event.snapshot;
    render();
  }

  function open() {
    panel.classList.remove("hidden");
    refresh();
  }

  async function requestControl(op, targetId) {
    try {
      const response = await fetch("/api/runtime/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, targetId }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      upsertControl(data);
      open();
      render();
    } catch { /* Ignore network errors; Hub will surface failures. */ }
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

  body.addEventListener("click", (event) => {
    const action = event.target.closest("[data-op]");
    if (action) { requestControl(action.dataset.op, action.dataset.target); return; }
    const decision = event.target.closest("[data-decision]");
    if (decision) { decide(decision.dataset.control, decision.dataset.decision === "approve"); return; }
    const cancel = event.target.closest("[data-cancel]");
    if (cancel) cancelControl(cancel.dataset.control);
  });
  toggle?.addEventListener("click", () => (panel.classList.contains("hidden") ? open() : panel.classList.add("hidden")));
  close?.addEventListener("click", () => panel.classList.add("hidden"));

  const interval = window.setInterval(() => { if (!panel.classList.contains("hidden")) refresh(); }, 15000);
  refresh();

  return { update, open, refresh, destroy: () => clearInterval(interval) };
}
