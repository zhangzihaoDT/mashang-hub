import assert from "node:assert/strict";
import { snapshotFromStatus, RUNTIME_PROTOCOL_VERSION } from "../worker/runtime/protocol.mjs";

const status = {
  services: [
    { id: "fetch", label: "mashang-fetch", online: true, managed: false, detail: "HTTP 200", pid: 123, url: "http://127.0.0.1:7860", legacy: [{ pid: 1, command: "old" }] },
    { id: "opencode", label: "OpenCode", online: false, managed: false, detail: "ECONNREFUSED" },
  ],
  jobs: [
    { id: "daily", label: "mashang-service daily pipeline", status: "FAILED", startedAt: "2026-10-07 09:00:01", finishedAt: "2026-10-07 09:00:01", failedStep: "refresh_full", source: "/local/path" },
  ],
};

const snapshot = snapshotFromStatus(status, { workerId: "w1", sequence: 3, generatedAt: "2026-10-07T00:00:00.000Z" });
assert.equal(snapshot.type, "runtime.snapshot");
assert.equal(snapshot.protocolVersion, RUNTIME_PROTOCOL_VERSION);
assert.equal(snapshot.workerId, "w1");
assert.equal(snapshot.sequence, 3);
assert.deepEqual(snapshot.services[0], { id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: false });
assert.deepEqual(snapshot.services[1], { id: "opencode", label: "OpenCode", status: "OFFLINE", managed: false });
assert.deepEqual(snapshot.jobs[0], {
  id: "daily",
  label: "mashang-service daily pipeline",
  lastRun: { status: "FAILED", startedAt: "2026-10-07 09:00:01", finishedAt: "2026-10-07 09:00:01" },
});

const serialized = JSON.stringify(snapshot);
for (const leaked of ["detail", "pid", "url", "legacy", "failedStep", "source", "127.0.0.1", "/local"]) {
  assert.equal(serialized.includes(leaked), false, `snapshot leaked "${leaked}"`);
}

console.log("Runtime protocol mapping checks passed");
