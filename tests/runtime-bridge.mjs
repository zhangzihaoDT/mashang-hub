import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = 34000 + Math.floor(Math.random() * 2000);
const secret = "test-worker-secret";
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, HUB_HOST: "127.0.0.1", PORT: String(port), WORKER_SECRET: secret, HUB_ACCESS_TOKEN: "" },
  stdio: ["ignore", "ignore", "pipe"],
});

async function getRuntime() {
  const response = await fetch(`${base}/api/runtime`);
  return response.json();
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
  ws.send(JSON.stringify({ type: "worker.register", workerId: "test-worker", status: "ONLINE", models: [] }));
  await sleep(100);

  ws.send(JSON.stringify({
    type: "runtime.snapshot",
    protocolVersion: 1,
    workerId: "test-worker",
    sequence: 1,
    generatedAt: "2026-10-07T00:00:00.000Z",
    services: [{ id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: true, detail: "leak", pid: 5 }],
    jobs: [{ id: "daily", label: "daily", lastRun: { status: "FAILED", source: "/local/leak" } }],
  }));

  const first = await waitFor(async () => {
    const body = await getRuntime();
    return body.snapshot ? body : null;
  }, "runtime snapshot was not stored");

  assert.equal(first.workerOnline, true);
  assert.ok(first.receivedAt, "receivedAt must be Hub-generated");
  assert.deepEqual(first.snapshot.services, [{ id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: true }]);
  assert.deepEqual(first.snapshot.jobs, [{ id: "daily", label: "daily", lastRun: { status: "FAILED", startedAt: null, finishedAt: null } }]);
  const serialized = JSON.stringify(first.snapshot);
  assert.equal(serialized.includes("leak"), false);
  assert.equal(serialized.includes("/local"), false);

  ws.send(JSON.stringify({
    type: "runtime.snapshot",
    protocolVersion: 1,
    workerId: "test-worker",
    sequence: 1,
    generatedAt: "2026-10-07T00:00:05.000Z",
    services: [{ id: "stale", label: "stale", status: "ONLINE", managed: false }],
    jobs: [],
  }));
  await sleep(200);
  const stale = await getRuntime();
  assert.equal(stale.snapshot.services[0].id, "fetch", "stale/duplicate sequence must be ignored");

  ws.send(JSON.stringify({
    type: "runtime.snapshot",
    protocolVersion: 1,
    workerId: "test-worker",
    sequence: 2,
    generatedAt: "2026-10-07T00:00:10.000Z",
    services: [{ id: "opencode", label: "OpenCode", status: "OFFLINE", managed: false }],
    jobs: [],
  }));
  const second = await waitFor(async () => {
    const body = await getRuntime();
    return body.snapshot?.sequence === 2 ? body : null;
  }, "newer sequence was not applied");
  assert.equal(second.snapshot.services[0].id, "opencode");

  ws.close();
  const offline = await waitFor(async () => {
    const body = await getRuntime();
    return body.workerOnline === false ? body : null;
  }, "workerOnline did not flip to false");
  assert.ok(offline.snapshot, "last snapshot should be retained after disconnect");

  console.log("Runtime worker-hub bridge checks passed");
} finally {
  server.kill("SIGKILL");
}
