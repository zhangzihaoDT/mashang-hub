import assert from "node:assert/strict";
import { snapshotFromStatus, RUNTIME_PROTOCOL_VERSION } from "../worker/runtime/protocol.mjs";

const status = {
  dependencies: [
    { id: "opencode", label: "OpenCode", online: false, detail: "ECONNREFUSED", pid: 123, url: "http://127.0.0.1:4096" },
  ],
  services: [
    { id: "fetch", label: "mashang-fetch", group: "APPS", online: true, managed: false, openUrl: "http://127.0.0.1:7860", detail: "HTTP 200", pid: 123, url: "http://127.0.0.1:7860/api/formats", legacy: [{ pid: 1, command: "old" }] },
  ],
  jobs: [
    { id: "daily", label: "Daily pipeline", group: "MASHANG-SERVICE", status: "FAILED", startedAt: "2026-10-07 09:00:01", finishedAt: "2026-10-07 09:00:01", failedStep: "refresh_full", source: "/local/path" },
  ],
};

const snapshot = snapshotFromStatus(status, { workerId: "w1", sequence: 3, generatedAt: "2026-10-07T00:00:00.000Z" });
assert.equal(snapshot.type, "runtime.snapshot");
assert.equal(snapshot.protocolVersion, RUNTIME_PROTOCOL_VERSION);
assert.equal(snapshot.workerId, "w1");
assert.equal(snapshot.sequence, 3);
assert.deepEqual(snapshot.dependencies, [{ id: "opencode", label: "OpenCode", status: "OFFLINE" }]);
assert.deepEqual(snapshot.services[0], { id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: false, group: "APPS", openUrl: "http://127.0.0.1:7860" });
assert.deepEqual(snapshot.jobs[0], {
  id: "daily",
  label: "Daily pipeline",
  group: "MASHANG-SERVICE",
  lastRun: { status: "FAILED", startedAt: "2026-10-07 09:00:01", finishedAt: "2026-10-07 09:00:01" },
});

const serialized = JSON.stringify(snapshot);
for (const leaked of ["detail", "pid", "legacy", "failedStep", "source", "/api/formats", "/local"]) {
  assert.equal(serialized.includes(leaked), false, `snapshot leaked "${leaked}"`);
}

console.log("Runtime protocol mapping checks passed");
