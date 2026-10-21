import assert from "node:assert/strict";

const elements = new Map();
function makeElement(id) {
  const listeners = {};
  return {
    id,
    dataset: {},
    innerHTML: "",
    textContent: "",
    className: "",
    classList: {
      set: new Set(),
      add(name) { this.set.add(name); },
      remove(name) { this.set.delete(name); },
      contains(name) { return this.set.has(name); },
      toggle(name, force) { if (force === undefined) { if (this.set.has(name)) this.set.delete(name); else this.set.add(name); } else if (force) this.set.add(name); else this.set.delete(name); },
    },
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return {open:false}; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); },
  };
}
for (const id of ["serviceRuntimeBar", "serviceRuntimeStatus", "openServiceRuntime", "runtimeDrawerDescription", "conversationRuntime", "independentRuntime", "marketReport", "aksignalRuntimeDrawer", "aksignalStatusBar", "aksignalRunStatus", "aksignalRunDetail", "aksignalRunDot", "openAksignalRuntime", "closeAksignalRuntime"]) elements.set(id, makeElement(id));

global.document = { getElementById: (id) => elements.get(id) || null };
global.window = { setInterval: () => 1, clearInterval: () => {} };

const calls = [];
let controlsPayload = [];
function runtimeResponse() {
  return { workerOnline: true, receivedAt: null, snapshot: { workerId: "local-worker", generatedAt: new Date().toISOString(), dependencies: [{ id: "opencode", label: "OpenCode", status: "ONLINE" }], services: [
    { id: "fetch", label: "mashang-fetch", group: "APPS", status: "ONLINE", managed: false, openUrl: "http://127.0.0.1:7860" },
    { id: "miit", workspace: "miit", label: "mashang-miit", group: "APPS", status: "OFFLINE", managed: false, openUrl: "http://127.0.0.1:8790" },
    { id: "myknbase", label: "myknbase", group: "APPS", status: "OFFLINE", managed: false, openUrl: "http://127.0.0.1:7870" },
    { id: "scheduler", label: "Scheduler", group: "MASHANG-SERVICE", summary: "后台服务", status: "ONLINE", managed: true },
    { id: "aksignal-scheduler", workspace: "aksignal", presentation: "schedule-control", label: "AKsignal Scheduler", group: "AKSIGNAL", summary: "独立调度", status: "OFFLINE", managed: false },
  ], jobs: [], operations: [
    { id: "aksignal-daily", workspace: "aksignal", label: "AKsignal Daily", description: "手动运行", enabled: true, requestOnly: true,
      details: { timezone: "Asia/Shanghai", targetDate: "20261015", error: "行业目标日数据未就绪", logLines: ["阶段失败：<script>"], publication: { trade_date: "20261014", run_id: "published-run", published_at: "2026-10-15T01:00:00Z" }, quality: { status: "CONFIRMED", data_complete: false, warnings: ["warning 1", "warning 2", "warning 3", "warning 4", "warning 5"], errors: [] }, schedule: { enabled: false, agentStatus: "OFFLINE", nextScheduledAt: "2026-10-17T08:30:00+08:00", manualPendingCount: 1, missedPolicy: "manual_only" } },
      lastRun: { status: "FAILED", startedAt: null, finishedAt: null } },
    { id: "aksignal-comparison-update", workspace: "aksignal", presentation: "inline-action", label: "更新 Compare", enabled: true, lastRun: { status: "IDLE" } },
    { id: "daily", label: "Daily pipeline", group: "MASHANG-SERVICE", description: "Daily operation", enabled: true, lastRun: { status: "FAILED", startedAt: "2026-10-07T09:00:00", finishedAt: "2026-10-07T09:00:00" } },
    { id: "future-no-arg", label: "Future operation", group: "MASHANG-SERVICE", description: "A Worker-provided operation", enabled: true, lastRun: { status: "IDLE" } },
    { id: "allupdate", label: "Full data update", group: "MASHANG-SERVICE", description: "Writes local data", enabled: true, lastRun: { status: "IDLE" } },
    { id: "disabled-operation", label: "Disabled operation", group: "MASHANG-SERVICE", description: "Unavailable", enabled: false, lastRun: { status: "UNKNOWN" } },
  ] } };
}
global.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  const json = url === "/api/runtime/controls" ? controlsPayload : url === "/api/runtime/control" ? { controlId: "control_1", op: "up", targetId: "fetch", status: "AWAITING_PERMISSION" } : runtimeResponse();
  return { ok: true, status: 200, json: async () => json };
};

const { initRuntimeUI } = await import("../public/runtime-ui.js");
const runtimeUI = initRuntimeUI();
await new Promise((resolve) => setTimeout(resolve, 0));
calls.length = 0;

const rendered = elements.get("conversationRuntime").innerHTML;
assert.match(rendered, /Daily pipeline/);
elements.get("openServiceRuntime").fire("click", { target: {} });
assert.equal(elements.get("aksignalRuntimeDrawer").open, true);
runtimeUI.update({ type: "runtime.snapshot", ...runtimeResponse() });
assert.equal(elements.get("aksignalRuntimeDrawer").open, true, "Service snapshot refresh keeps modal open");
assert.equal(elements.get("serviceRuntimeBar").classList.contains("hidden"), false);
assert.match(rendered, /data-op="run" data-target="future-no-arg"/);
assert.doesNotMatch(rendered, /data-target="fetch"/);
runtimeUI.setWorkspace("aksignal");
assert.equal(elements.get("serviceRuntimeBar").classList.contains("hidden"), true);
assert.equal(elements.get("aksignalRuntimeDrawer").open, false, "workspace switch closes prior modal");
const aksignalPanel = elements.get("conversationRuntime").innerHTML;
assert.match(aksignalPanel, /自动调度/);
assert.match(aksignalPanel, /恢复自动调度/);
assert.match(aksignalPanel, /错过或失败后不会自动补跑/);
assert.match(aksignalPanel, /手动运行 \/ 恢复/);
assert.match(aksignalPanel, /诊断详情 · 5 项质量提示/);
assert.match(aksignalPanel, /最近运行日志/);
assert.match(aksignalPanel, /阶段失败：&lt;script&gt;/);
assert.doesNotMatch(aksignalPanel, /<script>/);
assert.match(aksignalPanel, /正式日报已发布/);
assert.match(aksignalPanel, /10\/14/);
assert.match(aksignalPanel, /目标 10\/15 · <strong>更新失败 · 待恢复<\/strong>/);
assert.equal(elements.get("aksignalRunStatus").textContent, "10/15 更新失败 · 待恢复");
assert.equal(elements.get("aksignalStatusBar").classList.contains("hidden"), false);
assert.equal(elements.get("aksignalRuntimeDrawer").open, false, "runtime modal starts closed");
runtimeUI.update({type:"runtime.control.permission.requested",controlId:"daily-control",op:"run",targetId:"aksignal-daily"});
assert.equal(elements.get("aksignalRunStatus").textContent,"10/15 等待确认运行");
assert.equal(elements.get("aksignalRuntimeDrawer").open,true,"permission requests open the runtime modal");
assert.match(elements.get("conversationRuntime").innerHTML,/data-decision="approve"/);
assert.match(elements.get("conversationRuntime").innerHTML,/data-target="aksignal-daily" disabled/);
runtimeUI.update({type:"runtime.control.updated",controlId:"daily-control",op:"run",targetId:"aksignal-daily",status:"COMPLETED"});
assert.equal(elements.get("aksignalRunStatus").textContent,"10/15 更新失败 · 待恢复");
runtimeUI.setWorkspace("fetch");
assert.match(elements.get("independentRuntime").innerHTML, /打开工作台/);
assert.match(elements.get("independentRuntime").innerHTML, /data-op="restart" data-target="fetch"/);
runtimeUI.setWorkspace("miit");
assert.match(elements.get("independentRuntime").innerHTML, /<dt>Runtime ID<\/dt><dd>miit<\/dd>/);
assert.match(elements.get("independentRuntime").innerHTML, /data-op="up" data-target="miit"/);
assert.doesNotMatch(elements.get("independentRuntime").innerHTML, /打开工作台 ↗/);
runtimeUI.setWorkspace("knbase");
assert.match(elements.get("independentRuntime").innerHTML, /data-op="up" data-target="myknbase"/);
runtimeUI.update({type:"runtime.control.updated",controlId:"active-1",op:"up",targetId:"myknbase",status:"RUNNING"});
assert.match(elements.get("independentRuntime").innerHTML, /启动中/);
assert.match(elements.get("independentRuntime").innerHTML, /data-cancel="1"/);
runtimeUI.update({type:"runtime.control.updated",controlId:"active-1",op:"up",targetId:"myknbase",status:"COMPLETED"});
assert.match(elements.get("independentRuntime").innerHTML, /up · myknbase/);
assert.match(elements.get("independentRuntime").innerHTML, /<details class="runtime-history">/);
assert.match(elements.get("independentRuntime").innerHTML, /历史操作 ·/);
assert.doesNotMatch(elements.get("independentRuntime").innerHTML, /rt-current-actions/);
runtimeUI.setWorkspace("service");
const body = elements.get("conversationRuntime");
body.fire("click", { target: { closest: (selector) => (selector === "[data-op]" ? { dataset: { op: "restart", target: "fetch" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));

const created = calls.find((call) => call.url === "/api/runtime/control");
assert.ok(created, "clicking a control button must POST /api/runtime/control");
assert.equal(created.options.method, "POST");
assert.deepEqual(JSON.parse(created.options.body), { op: "restart", targetId: "fetch" });


calls.length = 0;
body.fire("click", { target: { closest: (selector) => (selector === "[data-op]" ? { dataset: { op: "run", target: "future-no-arg" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));
const genericOperationRequest = calls.find((call) => call.url === "/api/runtime/control");
assert.deepEqual(JSON.parse(genericOperationRequest.options.body), { op: "run", targetId: "future-no-arg" }, "Hub invokes an opaque operation without operation-specific UI logic");

calls.length = 0;
runtimeUI.setWorkspace("aksignal");
elements.get("marketReport").fire("click", { target: { closest: (selector) => selector === "[data-op]" ? { dataset: { op: "run", target: "aksignal-comparison-update" }, disabled: false } : null } });
await new Promise((resolve) => setTimeout(resolve, 0));
const inlineActionRequest = calls.find((call) => call.url === "/api/runtime/control");
assert.deepEqual(JSON.parse(inlineActionRequest.options.body), { op: "run", targetId: "aksignal-comparison-update" }, "inline research action uses generic runtime control");
elements.get("openAksignalRuntime").fire("click", { target: {} });
assert.equal(elements.get("aksignalRuntimeDrawer").open, true);
elements.get("closeAksignalRuntime").fire("click", { target: {} });
assert.equal(elements.get("aksignalRuntimeDrawer").open, false);

calls.length = 0;
body.fire("click", { target: { closest: (selector) => (selector === "[data-decision]" ? { dataset: { control: "control_1", decision: "approve" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));
const decided = calls.find((call) => call.url === "/api/runtime/controls/control_1/decision");
assert.ok(decided, "approving must POST the decision endpoint");
assert.deepEqual(JSON.parse(decided.options.body), { approve: true });

runtimeUI.setWorkspace("fetch");
assert.match(elements.get("independentRuntime").innerHTML, /data-decision="approve"/);
runtimeUI.setWorkspace("publish");
assert.match(elements.get("conversationRuntime").innerHTML, /正式发布尚未接入/);
assert.doesNotMatch(elements.get("conversationRuntime").innerHTML, /data-op=/);
assert.equal(elements.get("aksignalStatusBar").classList.contains("hidden"), true);
runtimeUI.destroy();
console.log("Workspace Runtime control wiring checks passed");
