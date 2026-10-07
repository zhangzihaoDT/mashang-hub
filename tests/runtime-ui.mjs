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
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); },
  };
}
for (const id of ["runtime", "runtimeBody", "runtimeMeta", "runtimeState", "runtimeWorkerId", "runtimeToggle", "runtimeClose"]) elements.set(id, makeElement(id));

global.document = { getElementById: (id) => elements.get(id) || null };
global.window = { setInterval: () => 1, clearInterval: () => {} };

const calls = [];
let controlsPayload = [];
function runtimeResponse() {
  return { workerOnline: true, receivedAt: null, snapshot: { workerId: "local-worker", generatedAt: null, dependencies: [{ id: "opencode", label: "OpenCode", status: "ONLINE" }], services: [
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

const rendered = elements.get("runtimeBody").innerHTML;
assert.equal(elements.get("runtimeWorkerId").textContent, "local-worker");
assert.match(rendered, /<h3>Worker<\/h3>/);
assert.match(rendered, /<h3>Dependencies<\/h3>/);
assert.match(rendered, /OpenCode/);
assert.match(rendered, /<h3>APPS<\/h3>/);
assert.match(rendered, /<h3>MASHANG-SERVICE<\/h3>/);
assert.equal((rendered.match(/<h3>MASHANG-SERVICE<\/h3>/g) || []).length, 1, "service and job entries should share one section");
assert.doesNotMatch(rendered, /<h3>(Services|Jobs)<\/h3>/);
assert.match(rendered, /href="http:\/\/127\.0\.0\.1:7860"[^>]*>mashang-fetch<\/a>/);
assert.match(rendered, /href="http:\/\/127\.0\.0\.1:7860"[^>]*>Open<\/a>/);
assert.match(rendered, /data-op="restart" data-target="fetch">Restart<\/button>/);
assert.match(rendered, /data-op="down" data-target="fetch">Down<\/button>/);
assert.doesNotMatch(rendered, /data-op="up" data-target="fetch"/);
assert.match(rendered, /data-op="up" data-target="myknbase">Up<\/button>/);
assert.doesNotMatch(rendered, /data-op="(down|restart)" data-target="myknbase"/);
assert.doesNotMatch(rendered, /data-op="up" data-target="scheduler"/);
assert.doesNotMatch(rendered, /data-op="run" data-target="scheduler"/);
assert.match(rendered, /后台服务/);
assert.match(rendered, /Daily pipeline/);
assert.match(rendered, /Failed · 09:00/);
assert.match(rendered, /data-op="run" data-target="daily">Run<\/button>/);
assert.match(rendered, /Full data update/);
assert.match(rendered, /data-op="run" data-target="allupdate">Run<\/button>/);
assert.match(rendered, /Future operation/);
assert.match(rendered, /data-op="run" data-target="future-no-arg">Run<\/button>/);
assert.match(rendered, /Disabled operation/);
assert.doesNotMatch(rendered, /data-op="run" data-target="disabled-operation"/);
assert.doesNotMatch(rendered, /href="http:\/\/127\.0\.0\.1:7870"/);
assert.equal(rendered.includes("外部"), false, "service labels must not imply an external system");
assert.equal(rendered.includes("托管"), false, "service control status is communicated by available actions");
assert.equal(rendered.includes('data-target="opencode"'), false, "dependencies must not expose controls");
assert.equal(rendered.includes("Mac Worker"), false);

runtimeUI.update({ type: "runtime.control.updated", controlId: "active-1", op: "up", targetId: "myknbase", status: "RUNNING" });
assert.match(elements.get("runtimeBody").innerHTML, /<h3>Control<\/h3>/);
assert.match(elements.get("runtimeBody").innerHTML, /myknbase · 启动中…/);
assert.doesNotMatch(elements.get("runtimeBody").innerHTML, /执行中/);
assert.match(elements.get("runtimeBody").innerHTML, /data-cancel="1"/);
runtimeUI.update({ type: "runtime.control.updated", controlId: "active-1", op: "up", targetId: "myknbase", status: "COMPLETED" });
assert.doesNotMatch(elements.get("runtimeBody").innerHTML, /<h3>Control<\/h3>/);
assert.match(elements.get("runtimeBody").innerHTML, /<details class="rt-recent">/);
assert.match(elements.get("runtimeBody").innerHTML, /up · myknbase/);

const body = elements.get("runtimeBody");
body.fire("click", { target: { closest: (selector) => (selector === "[data-op]" ? { dataset: { op: "restart", target: "fetch" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));

const created = calls.find((call) => call.url === "/api/runtime/control");
assert.ok(created, "clicking a control button must POST /api/runtime/control");
assert.equal(created.options.method, "POST");
assert.deepEqual(JSON.parse(created.options.body), { op: "restart", targetId: "fetch" });
assert.match(elements.get("runtimeBody").innerHTML, /<h3>Control<\/h3>/);

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

// Recent actions: active controls stay in Control, terminal ones are capped at
// the latest 5 and drop out after 30 minutes.
const now = Date.now();
const stale = 31 * 60 * 1000;
controlsPayload = [
  { controlId: "active-x", op: "up", targetId: "myknbase", status: "RUNNING", createdAt: now, updatedAt: now },
  { controlId: "stale", op: "run", targetId: "oldtarget", status: "COMPLETED", createdAt: now - stale, updatedAt: now - stale },
  ...Array.from({ length: 6 }, (_, i) => ({ controlId: `recent-${i}`, op: "run", targetId: `t${i}`, status: "COMPLETED", createdAt: now - i * 1000, updatedAt: now - i * 1000 })),
];
const recentUI = initRuntimeUI();
await recentUI.refresh();
const recentHtml = elements.get("runtimeBody").innerHTML;
assert.match(recentHtml, /<h3>Control<\/h3>/, "active control stays in Control");
assert.match(recentHtml, /myknbase · 启动中…/);
assert.match(recentHtml, /Recent actions <span>5<\/span>/, "only the latest 5 terminal controls are kept");
assert.match(recentHtml, /run · t4/);
assert.doesNotMatch(recentHtml, /run · t5/, "the 6th terminal control is dropped");
assert.doesNotMatch(recentHtml, /oldtarget/, "terminal controls older than 30 minutes are hidden");

console.log("Runtime UI control wiring checks passed");
