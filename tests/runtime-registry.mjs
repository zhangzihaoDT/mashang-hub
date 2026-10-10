import assert from "node:assert/strict";
import { buildRegistry, DAILY_PIPELINE_STARTS, DAILY_PIPELINE_STEPS } from "../worker/runtime/registry.mjs";

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
assert.equal(registry.jobs.length, 0);
assert.deepEqual(registry.operations.map((operation) => operation.id), ["daily", "allupdate"]);
const daily = registry.operations.find((operation) => operation.id === "daily");
assert.equal(daily.label, "Daily pipeline");
assert.equal(daily.group, "MASHANG-SERVICE");
assert.deepEqual(daily.probe.steps, [...DAILY_PIPELINE_STEPS]);
assert.deepEqual(daily.probe.startSteps, [...DAILY_PIPELINE_STARTS]);
assert.equal(daily.probe.logDir, "/tmp/svc/logs/scheduler");
assert.equal(daily.run.command, "make");
assert.deepEqual(daily.run.args, ["data-pipeline"]);
const allupdate = registry.operations.find((operation) => operation.id === "allupdate");
assert.equal(allupdate.run.command, "make");
assert.deepEqual(allupdate.run.args, ["allupdate"]);
assert.equal(allupdate.enabled, true);
assert.equal(registry.dependencies.find((d) => d.id === "opencode").probe.url, "http://127.0.0.1:5000/config/providers");
assert.equal(registry.services.find((s) => s.id === "fetch").probe.url, "http://127.0.0.1:6000/api/formats");
assert.equal(registry.services.find((s) => s.id === "fetch").openUrl, "http://127.0.0.1:6000");
assert.equal(registry.services.find((s) => s.id === "myknbase").probe.url, "http://127.0.0.1:7000/api/tree");
assert.equal(registry.services.find((s) => s.id === "myknbase").openUrl, "http://127.0.0.1:7000");
assert.equal(registry.probeTimeoutMs, 1000);

assert.equal(registry.dependencies.find((d) => d.id === "opencode").logs[0].path, "/tmp/hub/.local/logs/opencode.log");
assert.equal(registry.services.find((s) => s.id === "scheduler").logs[0].path, "/tmp/svc/logs/scheduler/stdout.log");
assert.ok(registry.services.find((s) => s.id === "fetch").logs[0].path.endsWith(".local/app.log"));
assert.equal(daily.logs[0].dir, "/tmp/svc/logs/scheduler");

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

assert.equal(registry.runtimeDir, "/tmp/hub/.local/runtime");

const overridden = buildRegistry(env, {
  services: [
    { id: "fetch", label: "custom-fetch", probe: { url: "http://127.0.0.1:9999/health" } },
    { id: "extra", label: "extra", probe: { type: "http", url: "http://127.0.0.1:1" } },
  ],
  jobs: [],
  operations: [
    { id: "future-no-arg", label: "Future operation", group: "MASHANG-SERVICE", enabled: true, run: { command: "make", args: ["future-op"], cwd: "/tmp/svc" } },
  ],
});

const fetch = overridden.services.find((s) => s.id === "fetch");
assert.equal(fetch.label, "custom-fetch");
assert.equal(fetch.probe.url, "http://127.0.0.1:9999/health");
assert.equal(fetch.probe.type, "http");
assert.ok(overridden.services.some((s) => s.id === "extra"));
assert.equal(overridden.services.length, 4);
assert.equal(overridden.jobs.length, 0);
assert.equal(overridden.operations.length, 3);
assert.ok(overridden.operations.some((operation) => operation.id === "future-no-arg"), "Worker config can add an operation without a Hub mapping");

console.log("Runtime registry checks passed");

const knbase = buildRegistry({}).services.find(s => s.id === "myknbase");
assert.equal(knbase.openUrl, "http://127.0.0.1:4317");
assert.ok(knbase.control.start.cwd.endsWith("Documents/github/mashang-knbase"));
assert.deepEqual(knbase.control.start.args, ["start"]);
assert.equal(knbase.control.start.env.PORT, "4317");
assert.ok(new RegExp(knbase.match).test("node server/main.mjs"));
assert.ok(!new RegExp(knbase.match).test("node server/index.js"));
assert.ok(!new RegExp(knbase.match).test("node server/main.mjs --root /tmp/trial --port 4318"));
