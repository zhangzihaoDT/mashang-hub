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
      toggle(name) { if (this.set.has(name)) this.set.delete(name); else this.set.add(name); },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return {open:false}; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); },
  };
}
for (const id of ["conversationRuntime", "independentRuntime"]) elements.set(id, makeElement(id));

global.document = { getElementById: (id) => elements.get(id) || null };
global.window = { setInterval: () => 1, clearInterval: () => {} };

const calls = [];
let controlsPayload = [];
function runtimeResponse() {
  return { workerOnline: true, receivedAt: null, snapshot: { workerId: "local-worker", generatedAt: new Date().toISOString(), dependencies: [{ id: "opencode", label: "OpenCode", status: "ONLINE" }], services: [
    { id: "fetch", label: "mashang-fetch", group: "APPS", status: "ONLINE", managed: false, openUrl: "http://127.0.0.1:7860" },
    { id: "myknbase", label: "myknbase", group: "APPS", status: "OFFLINE", managed: false, openUrl: "http://127.0.0.1:7870" },
    { id: "scheduler", label: "Scheduler", group: "MASHANG-SERVICE", summary: "后台服务", status: "ONLINE", managed: true },
  ], jobs: [], operations: [
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
assert.match(rendered, /data-op="run" data-target="future-no-arg"/);
assert.doesNotMatch(rendered, /data-target="fetch"/);
runtimeUI.setWorkspace("fetch");
assert.match(elements.get("independentRuntime").innerHTML, /打开工作台/);
assert.match(elements.get("independentRuntime").innerHTML, /data-op="restart" data-target="fetch"/);
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
runtimeUI.destroy();
console.log("Workspace Runtime control wiring checks passed");
