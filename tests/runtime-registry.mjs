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
