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
assert.deepEqual(ids, ["fetch", "myknbase", "scheduler"]);
assert.equal(registry.services.length, 3);
assert.deepEqual(registry.dependencies.map((dependency) => dependency.id), ["opencode"]);
assert.equal(registry.jobs.length, 1);
assert.equal(registry.jobs[0].id, "daily");
assert.equal(registry.jobs[0].label, "Daily pipeline");
assert.equal(registry.jobs[0].group, "MASHANG-SERVICE");
assert.deepEqual(registry.jobs[0].probe.steps, [...DAILY_PIPELINE_STEPS]);
assert.equal(registry.jobs[0].probe.logDir, "/tmp/svc/logs/scheduler");
assert.equal(registry.dependencies.find((d) => d.id === "opencode").probe.url, "http://127.0.0.1:5000/config/providers");
assert.equal(registry.services.find((s) => s.id === "fetch").probe.url, "http://127.0.0.1:6000/api/formats");
assert.equal(registry.services.find((s) => s.id === "fetch").openUrl, "http://127.0.0.1:6000");
assert.equal(registry.services.find((s) => s.id === "myknbase").probe.url, "http://127.0.0.1:7000/api/health");
assert.equal(registry.services.find((s) => s.id === "myknbase").openUrl, "http://127.0.0.1:7000");
assert.equal(registry.probeTimeoutMs, 1000);

assert.equal(registry.dependencies.find((d) => d.id === "opencode").logs[0].path, "/tmp/hub/.local/logs/opencode.log");
assert.equal(registry.services.find((s) => s.id === "scheduler").logs[0].path, "/tmp/svc/logs/scheduler/stdout.log");
assert.ok(registry.services.find((s) => s.id === "fetch").logs[0].path.endsWith(".local/app.log"));
assert.equal(registry.jobs[0].logs[0].dir, "/tmp/svc/logs/scheduler");

const scheduler = registry.services.find((s) => s.id === "scheduler");
assert.equal(scheduler.label, "Scheduler");
assert.equal(scheduler.group, "MASHANG-SERVICE");
assert.equal(scheduler.summary, "后台服务");
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

assert.equal(registry.services.some((s) => s.id === "worker"), false);

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
assert.equal(overridden.services.length, 4);
assert.equal(overridden.jobs.length, 1);

console.log("Runtime registry checks passed");
