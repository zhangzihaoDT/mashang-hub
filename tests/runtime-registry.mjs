import assert from "node:assert/strict";
import { buildRegistry, DAILY_PIPELINE_STEPS } from "../worker/runtime/registry.mjs";

const env = {
  MASHANG_SERVICE_ROOT: "/tmp/svc",
  MASHANG_HUB_ROOT: "/tmp/hub",
  OPENCODE_URL: "http://127.0.0.1:5000/",
  MASHANG_FETCH_URL: "http://127.0.0.1:6000",
  MYKNBASE_URL: "http://127.0.0.1:7000",
  RUNTIME_PROBE_TIMEOUT_MS: "1000",
};

const registry = buildRegistry(env);
const ids = registry.services.map((service) => service.id);
assert.deepEqual(ids, ["fetch", "myknbase", "opencode", "worker", "scheduler"]);
assert.equal(registry.services.length, 5);
assert.equal(registry.jobs.length, 1);
assert.equal(registry.jobs[0].id, "daily");
assert.deepEqual(registry.jobs[0].probe.steps, [...DAILY_PIPELINE_STEPS]);
assert.equal(registry.jobs[0].probe.logDir, "/tmp/svc/logs/scheduler");
assert.equal(registry.services.find((s) => s.id === "opencode").probe.url, "http://127.0.0.1:5000/config/providers");
assert.equal(registry.services.find((s) => s.id === "fetch").probe.url, "http://127.0.0.1:6000/api/formats");
assert.equal(registry.services.find((s) => s.id === "myknbase").probe.url, "http://127.0.0.1:7000/api/health");
assert.equal(registry.services.find((s) => s.id === "worker").probe.pidFile, "/tmp/hub/.local/pids/worker.pid");
assert.equal(registry.probeTimeoutMs, 1000);

assert.equal(registry.services.find((s) => s.id === "opencode").logs[0].path, "/tmp/hub/.local/logs/opencode.log");
assert.equal(registry.services.find((s) => s.id === "worker").logs[0].path, "/tmp/hub/.local/logs/worker.log");
assert.equal(registry.services.find((s) => s.id === "scheduler").logs[0].path, "/tmp/svc/logs/scheduler/stdout.log");
assert.ok(registry.services.find((s) => s.id === "fetch").logs[0].path.endsWith(".local/app.log"));
assert.equal(registry.jobs[0].logs[0].dir, "/tmp/svc/logs/scheduler");

const scheduler = registry.services.find((s) => s.id === "scheduler");
assert.equal(scheduler.match, "utility_scripts/sales_scheduler.py");
assert.deepEqual(scheduler.legacy, ["schedule_launch_lock_evening_updates"]);
assert.equal(scheduler.control.start.command, "caffeinate");
assert.deepEqual(scheduler.control.start.args, ["-i", "make", "sales-scheduler"]);
assert.equal(scheduler.control.start.detach, true);
assert.equal(scheduler.control.start.cwd, "/tmp/svc");

const fetchControl = registry.services.find((s) => s.id === "fetch").control;
assert.equal(fetchControl.start.detach, false);
assert.equal(fetchControl.start.command, "./scripts/dev.sh");
assert.deepEqual(fetchControl.stop, { command: "./scripts/dev.sh", args: ["stop"], cwd: fetchControl.start.cwd });

const workerControl = registry.services.find((s) => s.id === "worker").control;
assert.equal(workerControl.start.cwd, "/tmp/hub");
assert.equal(workerControl.start.env.MASHANG_SERVICE_ROOT, "/tmp/svc");
assert.equal(workerControl.start.env.OPENCODE_URL, "http://127.0.0.1:5000");

assert.equal(registry.jobs[0].control.run.command, "make");
assert.deepEqual(registry.jobs[0].control.run.args, ["daily-ops"]);
assert.equal(registry.runtimeDir, "/tmp/hub/.local/runtime");

const overridden = buildRegistry(env, {
  services: [
    { id: "fetch", label: "custom-fetch", probe: { url: "http://127.0.0.1:9999/health" } },
    { id: "extra", label: "extra", probe: { type: "http", url: "http://127.0.0.1:1" } },
  ],
  jobs: [],
});

const fetch = overridden.services.find((s) => s.id === "fetch");
assert.equal(fetch.label, "custom-fetch");
assert.equal(fetch.probe.url, "http://127.0.0.1:9999/health");
assert.equal(fetch.probe.type, "http");
assert.ok(overridden.services.some((s) => s.id === "extra"));
assert.equal(overridden.services.length, 6);
assert.equal(overridden.jobs.length, 1);

console.log("Runtime registry checks passed");
