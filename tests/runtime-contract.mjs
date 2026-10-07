import assert from "node:assert/strict";
import { sanitizeRuntimeSnapshot } from "../server/runtime-contract.mjs";

assert.equal(sanitizeRuntimeSnapshot(null), null);
assert.equal(sanitizeRuntimeSnapshot({ type: "runtime.snapshot", protocolVersion: 2 }), null);
assert.equal(sanitizeRuntimeSnapshot({ type: "other", protocolVersion: 1 }), null);

const clean = sanitizeRuntimeSnapshot({
  type: "runtime.snapshot",
  protocolVersion: 1,
  workerId: "w1",
  sequence: 4,
  generatedAt: "2026-10-07T00:00:00.000Z",
  evil: "x",
  services: [
    { id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: true, detail: "HTTP 200", pid: 99, command: "rm -rf", path: "/local" },
    { id: "x", status: "BOGUS" },
    { label: "no-id" },
  ],
  jobs: [
    { id: "daily", label: "daily", lastRun: { status: "FAILED", failedStep: "refresh_full", source: "/local" } },
    { id: "j2", status: "RUNNING" },
  ],
});

assert.deepEqual(clean.services, [
  { id: "fetch", label: "mashang-fetch", status: "ONLINE", managed: true },
  { id: "x", label: "x", status: "UNKNOWN", managed: false },
]);
assert.deepEqual(clean.jobs, [
  { id: "daily", label: "daily", lastRun: { status: "FAILED", startedAt: null, finishedAt: null } },
  { id: "j2", label: "j2", lastRun: { status: "UNKNOWN", startedAt: null, finishedAt: null } },
]);
assert.equal(clean.sequence, 4);

const serialized = JSON.stringify(clean);
for (const leaked of ["detail", "pid", "command", "path", "failedStep", "source", "evil"]) {
  assert.equal(serialized.includes(leaked), false, `sanitized snapshot leaked "${leaked}"`);
}

console.log("Runtime hub contract checks passed");
