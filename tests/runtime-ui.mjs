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
for (const id of ["runtime", "runtimeBody", "runtimeMeta", "runtimeState", "runtimeToggle", "runtimeClose"]) elements.set(id, makeElement(id));

global.document = { getElementById: (id) => elements.get(id) || null };
global.window = { setInterval: () => 1, clearInterval: () => {} };

const calls = [];
function runtimeResponse() {
  return { workerOnline: true, receivedAt: null, snapshot: { generatedAt: null, services: [{ id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: false }], jobs: [] } };
}
global.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  const json = url === "/api/runtime/controls" ? [] : url === "/api/runtime/control" ? { controlId: "control_1", op: "up", targetId: "fetch", status: "AWAITING_PERMISSION" } : runtimeResponse();
  return { ok: true, status: 200, json: async () => json };
};

const { initRuntimeUI } = await import("../public/runtime-ui.js");
initRuntimeUI();
await new Promise((resolve) => setTimeout(resolve, 0));
calls.length = 0;

const body = elements.get("runtimeBody");
body.fire("click", { target: { closest: (selector) => (selector === "[data-op]" ? { dataset: { op: "up", target: "fetch" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));

const created = calls.find((call) => call.url === "/api/runtime/control");
assert.ok(created, "clicking a control button must POST /api/runtime/control");
assert.equal(created.options.method, "POST");
assert.deepEqual(JSON.parse(created.options.body), { op: "up", targetId: "fetch" });

calls.length = 0;
body.fire("click", { target: { closest: (selector) => (selector === "[data-decision]" ? { dataset: { control: "control_1", decision: "approve" } } : null) } });
await new Promise((resolve) => setTimeout(resolve, 0));
const decided = calls.find((call) => call.url === "/api/runtime/controls/control_1/decision");
assert.ok(decided, "approving must POST the decision endpoint");
assert.deepEqual(JSON.parse(decided.options.body), { approve: true });

console.log("Runtime UI control wiring checks passed");
