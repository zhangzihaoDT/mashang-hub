import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../worker/runtime/registry.mjs";
import { executeControl, down } from "../worker/runtime/control.mjs";
import { readManualJob, readManualOperation } from "../worker/runtime/jobs.mjs";
import { collectStatus } from "../worker/runtime/status.mjs";

const silent = { log() {}, warn() {} };
const root = await mkdtemp(join(tmpdir(), "mashang-control-exec-"));
const token = `MASHANG_EXEC_${process.pid}_${Date.now()}`;

const registry = buildRegistry({ MASHANG_HUB_ROOT: root }, {
  runtimeDir: join(root, "runtime"),
  verifyMs: 6000,
  probeTimeoutMs: 1500,
  services: [
    {
      id: "scenario",
      label: "scenario",
      probe: { type: "process", match: token },
      match: token,
      control: {
        start: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", token], cwd: root, detach: true },
        stop: { signal: "SIGTERM", timeoutMs: 3000 },
      },
    },
  ],
  jobs: [
    { id: "quick", label: "quick", probe: { type: "noop" }, control: { run: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root } } },
    { id: "boom", label: "boom", probe: { type: "noop" }, control: { run: { command: process.execPath, args: ["-e", "process.exit(5)"], cwd: root } } },
    { id: "slow", label: "slow", probe: { type: "noop" }, control: { run: { command: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"], cwd: root } } },
  ],
  operations: [
    { id: "future-no-arg", label: "Future operation", enabled: true, cancellationSupported: true, probe: { type: "none" }, run: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root } },
    { id: "future-slow", label: "Future slow operation", enabled: true, cancellationSupported: true, probe: { type: "none" }, run: { command: process.execPath, args: ["-e", "setTimeout(()=>{},30000)"], cwd: root } },
    { id: "future-disabled", label: "Disabled operation", enabled: false, probe: { type: "none" }, run: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root } },
  ],
});

const service = registry.services.find((s) => s.id === "scenario");

try {
  assert.deepEqual(await executeControl(registry, { op: "run", targetId: "quick", log: silent }), { status: "COMPLETED", reason: "OK", code: 0 });
  assert.deepEqual(await executeControl(registry, { op: "run", targetId: "boom", log: silent }), { status: "FAILED", reason: "JOB_FAILED", code: 5 });
  assert.deepEqual(await executeControl(registry, { op: "run", targetId: "missing", log: silent }), { status: "REFUSED", reason: "UNKNOWN_TARGET" });
  const operationUpdates = [];
  assert.deepEqual(await executeControl(registry, { op: "run", targetId: "future-no-arg", log: silent, onOperationStatus: () => operationUpdates.push("updated") }), { status: "COMPLETED", reason: "OK", code: 0 });
  assert.deepEqual(operationUpdates, ["updated", "updated"], "operation status is published before and after execution");
  assert.deepEqual(await executeControl(registry, { op: "run", targetId: "future-disabled", log: silent }), { status: "REFUSED", reason: "OPERATION_DISABLED" });

  const quickState = await readManualJob(registry.runtimeDir, "quick");
  assert.equal(quickState.status, "COMPLETED");
  assert.equal(quickState.code, 0);
  assert.ok(quickState.startedAt && quickState.finishedAt, "manual run timestamps must be persisted");
  const boomState = await readManualJob(registry.runtimeDir, "boom");
  assert.equal(boomState.status, "FAILED");
  assert.equal(boomState.code, 5);

  const status = await collectStatus(registry);
  assert.equal(status.jobs.find((job) => job.id === "quick").status, "COMPLETED", "lastRun must use the manual run");
  assert.equal(status.jobs.find((job) => job.id === "boom").status, "FAILED");
  assert.equal(status.operations.find((operation) => operation.id === "future-no-arg").lastRun.status, "COMPLETED");
  assert.equal(status.operations.find((operation) => operation.id === "future-no-arg").enabled, true);

  const up = await executeControl(registry, { op: "up", targetId: "scenario", log: silent });
  assert.equal(up.status, "COMPLETED");
  const again = await executeControl(registry, { op: "up", targetId: "scenario", log: silent });
  assert.deepEqual(again, { status: "COMPLETED", reason: "OK" });
  const stop = await executeControl(registry, { op: "down", targetId: "scenario", log: silent });
  assert.deepEqual(stop, { status: "COMPLETED", reason: "OK" });
  assert.deepEqual(await executeControl(registry, { op: "bogus", targetId: "scenario", log: silent }), { status: "REFUSED", reason: "UNKNOWN_OP" });

  const controller = new AbortController();
  const running = executeControl(registry, { op: "run", targetId: "slow", signal: controller.signal, log: silent });
  setTimeout(() => controller.abort(), 300);
  assert.deepEqual(await running, { status: "CANCELLED", reason: "CANCELLED" });

  const slowState = await readManualJob(registry.runtimeDir, "slow");
  assert.equal(slowState.status, "CANCELLED", "a cancelled manual run must have a terminal cancelled state");
  assert.ok(slowState.finishedAt, "a cancelled manual run must record finishedAt");

  const operationController = new AbortController();
  const slowOperation = executeControl(registry, { op: "run", targetId: "future-slow", signal: operationController.signal, log: silent });
  setTimeout(() => operationController.abort(), 300);
  assert.deepEqual(await slowOperation, { status: "CANCELLED", reason: "CANCELLED" });
  const cancelledOperation = await readManualOperation(registry.runtimeDir, "future-slow");
  assert.equal(cancelledOperation.status, "CANCELLED", "cancelled operation status must persist as CANCELLED");

  console.log("Runtime control execution checks passed");
} finally {
  await down(service, registry, { log: silent }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
