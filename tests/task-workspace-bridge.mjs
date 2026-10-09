import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 38000 + Math.floor(Math.random() * 2000);
const secret = "test-workspace-secret";
const base = `http://127.0.0.1:${port}`;
const turnLog = join(mkdtempSync(join(tmpdir(), "mashang-turnlog-")), "turns.jsonl");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, HUB_HOST: "127.0.0.1", PORT: String(port), WORKER_SECRET: secret, HUB_ACCESS_TOKEN: "", HUB_TURN_LOG: turnLog },
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
async function waitFor(predicate, message) {
  for (let i = 0; i < 60; i += 1) {
    const value = await predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(message);
}

try {
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/health`)).ok;
    } catch {
      return false;
    }
  }, "hub did not start");

  const ws = new WebSocket(`ws://127.0.0.1:${port}/worker`, { headers: { Authorization: `Bearer ${secret}` } });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  const taskCreates = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "task.create") taskCreates.push(message);
  });
  ws.send(JSON.stringify({ type: "worker.register", workerId: "workspace-worker", status: "ONLINE", models: [], workspaces: [{ id: "myknbase", label: "myknbase" }, { id: "bad id!", label: "bad" }] }));
  await sleep(150);

  const advertised = await api("/api/workspaces");
  assert.deepEqual(advertised.body.workspaces, [{ id: "myknbase", label: "myknbase" }], "Hub exposes only shape-valid workspace ids");

  const session = (await api("/api/sessions", "POST", { title: "workspace-test" })).body;
  const model = { providerID: "deepseek", modelID: "deepseek-flash" };

  const withWorkspace = await api(`/api/sessions/${encodeURIComponent(session.id)}/message`, "POST", { model, workspaceId: "myknbase", parts: [{ type: "text", text: "hello" }] });
  assert.equal(withWorkspace.status, 202);
  assert.equal(withWorkspace.body.workspaceId, "myknbase", "publicTask echoes the workspaceId");
  const first = await waitFor(() => taskCreates[0], "worker did not receive task.create");
  assert.equal(first.workspaceId, "myknbase", "Hub forwards the opaque workspaceId unchanged");

  const invalid = await api(`/api/sessions/${encodeURIComponent(session.id)}/message`, "POST", { model, workspaceId: "bad id!", parts: [{ type: "text", text: "hello" }] });
  assert.equal(invalid.status, 400, "malformed workspaceId is rejected before dispatch");

  const noWorkspace = await api(`/api/sessions/${encodeURIComponent(session.id)}/message`, "POST", { model, parts: [{ type: "text", text: "hello" }] });
  assert.equal(noWorkspace.status, 202);
  assert.equal(noWorkspace.body.workspaceId, null);
  const second = await waitFor(() => taskCreates[1], "worker did not receive the second task.create");
  assert.equal(second.workspaceId, null, "omitted workspaceId is forwarded as null so the Worker applies its default");

  ws.close();
  console.log("Task workspace worker-hub bridge checks passed");
} finally {
  server.kill("SIGKILL");
}
