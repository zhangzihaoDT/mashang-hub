const SERVICE_STATES = {
  ONLINE: { label: "在线", cls: "online" },
  OFFLINE: { label: "离线", cls: "offline" },
  UNKNOWN: { label: "未知", cls: "unknown" },
};
const JOB_STATES = {
  COMPLETED: { label: "完成", cls: "completed" },
  FAILED: { label: "失败", cls: "failed" },
  RUNNING: { label: "运行中", cls: "running" },
  UNKNOWN: { label: "未知", cls: "unknown" },
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

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function stateOf(map, key) { return map[key] || map.UNKNOWN; }
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
    controls.set(control.controlId, { ...previous, ...control });
    if (controls.size > 12) {
      const oldest = [...controls.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
      if (oldest) controls.delete(oldest.controlId);
    }
  }

  function actionButtons(ops, targetId) {
    return ops.map((op) => `<button class="rt-btn" type="button" data-op="${op}" data-target="${escapeHTML(targetId)}">${op}</button>`).join("");
  }
  function serviceItem(service) {
    const state = stateOf(SERVICE_STATES, service.status);
    const tag = service.status === "ONLINE" ? `<span class="rt-tag">${service.managed ? "托管" : "外部"}</span>` : "";
    return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(service.label || service.id)}</strong><span class="rt-sub">${state.label}</span></div>${tag}<div class="rt-actions">${actionButtons(["up", "down", "restart"], service.id)}</div></li>`;
  }
  function jobItem(job) {
    const last = job.lastRun || {};
    const state = stateOf(JOB_STATES, last.status);
    const when = last.finishedAt || last.startedAt;
    const sub = when ? `${state.label} · ${escapeHTML(formatTime(when))}` : state.label;
    return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(job.label || job.id)}</strong><span class="rt-sub">${sub}</span></div><div class="rt-actions">${actionButtons(["run"], job.id)}</div></li>`;
  }
  function controlItem(control) {
    const state = stateOf(CONTROL_STATES, control.status);
    const reason = control.reason && control.status !== "COMPLETED" ? ` · ${escapeHTML(control.reason)}` : "";
    let actions = "";
    if (control.status === "AWAITING_PERMISSION") {
      actions = `<button class="rt-btn allow" data-control="${escapeHTML(control.controlId)}" data-decision="approve">允许</button><button class="rt-btn reject" data-control="${escapeHTML(control.controlId)}" data-decision="reject">拒绝</button>`;
    } else if (control.status === "RUNNING") {
      actions = `<button class="rt-btn" data-control="${escapeHTML(control.controlId)}" data-cancel="1">取消</button>`;
    }
    return `<li class="rt-item rt-control"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(control.op)} · ${escapeHTML(targetLabel(control.targetId))}</strong><span class="rt-sub">${state.label}${reason}</span></div><div class="rt-actions">${actions}</div></li>`;
  }

  function render() {
    if (stateEl) {
      stateEl.textContent = workerOnline ? "Worker 在线" : "Worker 离线";
      stateEl.className = `runtime-state ${workerOnline ? "online" : "offline"}`;
    }
    meta.textContent = `快照 ${formatTime(snapshot?.generatedAt)} · 接收 ${formatTime(receivedAt)}`;

    const sections = [];
    const controlList = [...controls.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (controlList.length) sections.push(`<div class="rt-group"><h3>Controls</h3><ul class="rt-list">${controlList.map(controlItem).join("")}</ul></div>`);

    const services = snapshot?.services || [];
    const jobs = snapshot?.jobs || [];
    if (!snapshot || (!services.length && !jobs.length)) {
      sections.push(`<div class="rt-empty">暂无 Runtime 快照。Worker 连接后会自动上报。</div>`);
    } else {
      sections.push(`<div class="rt-group"><h3>Services</h3><ul class="rt-list">${services.map(serviceItem).join("") || `<li class="rt-item"><div class="rt-main"><span class="rt-sub">无</span></div></li>`}</ul></div>`);
      sections.push(`<div class="rt-group"><h3>Jobs</h3><ul class="rt-list">${jobs.map(jobItem).join("") || `<li class="rt-item"><div class="rt-main"><span class="rt-sub">无</span></div></li>`}</ul></div>`);
    }
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
