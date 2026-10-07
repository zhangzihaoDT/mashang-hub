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

function serviceItem(service) {
  const state = stateOf(SERVICE_STATES, service.status);
  const tag = service.status === "ONLINE" ? `<span class="rt-tag">${service.managed ? "托管" : "外部"}</span>` : "";
  return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(service.label || service.id)}</strong><span class="rt-sub">${state.label}</span></div>${tag}</li>`;
}
function jobItem(job) {
  const last = job.lastRun || {};
  const state = stateOf(JOB_STATES, last.status);
  const when = last.finishedAt || last.startedAt;
  const sub = when ? `${state.label} · ${escapeHTML(formatTime(when))}` : state.label;
  return `<li class="rt-item"><span class="rt-dot ${state.cls}"></span><div class="rt-main"><strong>${escapeHTML(job.label || job.id)}</strong><span class="rt-sub">${sub}</span></div></li>`;
}

/**
 * Read-only Runtime drawer. Consumes GET /api/runtime on open/interval and
 * live `runtime.snapshot` SSE events forwarded from the Hub.
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

  function render() {
    if (stateEl) {
      stateEl.textContent = workerOnline ? "Worker 在线" : "Worker 离线";
      stateEl.className = `runtime-state ${workerOnline ? "online" : "offline"}`;
    }
    meta.textContent = `快照 ${formatTime(snapshot?.generatedAt)} · 接收 ${formatTime(receivedAt)}`;

    const services = snapshot?.services || [];
    const jobs = snapshot?.jobs || [];
    if (!snapshot || (!services.length && !jobs.length)) {
      body.innerHTML = `<div class="rt-empty">暂无 Runtime 快照。Worker 连接后会自动上报。</div>`;
      return;
    }
    const empty = `<li class="rt-item"><div class="rt-main"><span class="rt-sub">无</span></div></li>`;
    body.innerHTML = [
      `<div class="rt-group"><h3>Services</h3><ul class="rt-list">${services.map(serviceItem).join("") || empty}</ul></div>`,
      `<div class="rt-group"><h3>Jobs</h3><ul class="rt-list">${jobs.map(jobItem).join("") || empty}</ul></div>`,
    ].join("");
  }

  async function refresh() {
    try {
      const response = await fetch("/api/runtime", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      workerOnline = Boolean(data.workerOnline);
      receivedAt = data.receivedAt || null;
      snapshot = data.snapshot || null;
      render();
    } catch {
      /* Keep the last known snapshot. */
    }
  }

  function update(event) {
    workerOnline = Boolean(event.workerOnline);
    if (event.receivedAt) receivedAt = event.receivedAt;
    if (event.snapshot) snapshot = event.snapshot;
    render();
  }

  function open() {
    panel.classList.remove("hidden");
    refresh();
  }

  toggle?.addEventListener("click", () => (panel.classList.contains("hidden") ? open() : panel.classList.add("hidden")));
  close?.addEventListener("click", () => panel.classList.add("hidden"));

  const interval = window.setInterval(() => { if (!panel.classList.contains("hidden")) refresh(); }, 15000);
  refresh();

  return { update, open, refresh, destroy: () => clearInterval(interval) };
}
