import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 36000 + Math.floor(Math.random() * 2000);
const secret = "test-control-secret";
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    HUB_HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_SECRET: secret,
    HUB_ACCESS_TOKEN: "",
    CONTROL_CANCEL_GRACE_MS: "400",
    CONTROL_TIMEOUT_MS: "60000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

async function api(path, method = "GET", bodyValue) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: bodyValue ? JSON.stringify(bodyValue) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function waitControl(controlId, status) {
  for (let i = 0; i < 60; i += 1) {
    const { body } = await api(`/api/runtime/controls/${controlId}`);
    if (body.status === status) return body;
    await sleep(100);
  }
  throw new Error(`control ${controlId} never reached ${status}`);
}

try {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* retry */ }
    await sleep(100);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { Authorization: `Bearer ${secret}` } });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.send(JSON.stringify({ type: "worker.register", workerId: "control-worker", status: "ONLINE", models: [] }));
  ws.send(JSON.stringify({
    type: "runtime.snapshot",
    protocolVersion: 1,
    workerId: "control-worker",
    sequence: 1,
    generatedAt: new Date().toISOString(),
    dependencies: [{ id: "opencode", label: "OpenCode", status: "ONLINE" }],
    services: [{ id: "instant", label: "instant", status: "ONLINE", managed: true }],
    jobs: ["hold", "hold-drop"].map((id) => ({ id, label: id, lastRun: { status: "UNKNOWN" } })),
  }));
  await sleep(100);

  const requests = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "runtime.control.request") {
      requests.push(message);
      if (!message.targetId.startsWith("hold")) {
        ws.send(JSON.stringify({ type: "runtime.control.result", controlId: message.controlId, status: "COMPLETED", reason: "OK", code: null }));
      }
    }
    if (message.type === "runtime.control.cancel") {
      ws.send(JSON.stringify({ type: "runtime.control.result", controlId: message.controlId, status: "CANCELLED", reason: "CANCELLED", code: null }));
    }
  });

  const created = await api("/api/runtime/control", "POST", { op: "up", targetId: "instant" });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, "AWAITING_PERMISSION");
  const controlId = created.body.controlId;

  const pending = await api(`/api/runtime/controls/${controlId}`);
  assert.equal(pending.body.status, "AWAITING_PERMISSION");
  assert.equal((await api("/api/runtime/controls")).body.length, 1);

  const badOp = await api("/api/runtime/control", "POST", { op: "stop", targetId: "x" });
  assert.equal(badOp.status, 400);
  const dependencyControl = await api("/api/runtime/control", "POST", { op: "restart", targetId: "opencode" });
  assert.equal(dependencyControl.status, 404);
  assert.equal(dependencyControl.body.reason, "UNKNOWN_TARGET");
  const wrongKind = await api("/api/runtime/control", "POST", { op: "run", targetId: "instant" });
  assert.equal(wrongKind.status, 404);
  assert.equal(wrongKind.body.reason, "UNKNOWN_TARGET");

  const decided = await api(`/api/runtime/controls/${controlId}/decision`, "POST", { approve: true });
  assert.equal(decided.body.status, "RUNNING");
  const completed = await waitControl(controlId, "COMPLETED");
  assert.equal(completed.op, "up");
  assert.equal(requests.at(-1).controlId, controlId);

  const rejected = await api("/api/runtime/control", "POST", { op: "down", targetId: "instant" });
  const rejectedResult = await api(`/api/runtime/controls/${rejected.body.controlId}/decision`, "POST", { approve: false });
  assert.equal(rejectedResult.body.status, "REJECTED");

  const holding = await api("/api/runtime/control", "POST", { op: "run", targetId: "hold" });
  await api(`/api/runtime/controls/${holding.body.controlId}/decision`, "POST", { approve: true });
  await waitControl(holding.body.controlId, "RUNNING");
  const cancelled = await api(`/api/runtime/controls/${holding.body.controlId}/cancel`, "POST");
  assert.equal(cancelled.status, 202);
  await waitControl(holding.body.controlId, "CANCELLED");

  const dropped = await api("/api/runtime/control", "POST", { op: "run", targetId: "hold-drop" });
  await api(`/api/runtime/controls/${dropped.body.controlId}/decision`, "POST", { approve: true });
  await waitControl(dropped.body.controlId, "RUNNING");
  ws.close();
  await waitControl(dropped.body.controlId, "FAILED");

  console.log("Runtime control worker-hub bridge checks passed");
} finally {
  server.kill("SIGKILL");
}
