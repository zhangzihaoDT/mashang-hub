import assert from "node:assert/strict";
import { timeoutConfig, softDeadline, hardDeadline, isTerminal, REASONS, TERMINAL_STATES } from "../server/task-timeout.mjs";

const defaults = timeoutConfig({});
assert.equal(defaults.requestMs, 180000);
assert.equal(defaults.graceMs, 10000);

const custom = timeoutConfig({ TASK_TIMEOUT_MS: "5000", TASK_CANCEL_GRACE_MS: "1000" });
assert.equal(custom.requestMs, 5000);
assert.equal(custom.graceMs, 1000);

const invalid = timeoutConfig({ TASK_TIMEOUT_MS: "-1", TASK_CANCEL_GRACE_MS: "abc" });
assert.equal(invalid.requestMs, 180000);
assert.equal(invalid.graceMs, 10000);

const startedAt = 1000;
assert.equal(softDeadline(startedAt, custom), 6000);
assert.equal(hardDeadline(startedAt, custom), 7000);

assert.deepEqual([...TERMINAL_STATES], ["COMPLETED", "FAILED", "INTERRUPTED", "TIMEOUT", "CANCELLED"]);
assert.equal(isTerminal("TIMEOUT"), true);
assert.equal(isTerminal("RUNNING"), false);
assert.equal(REASONS.WORKER_REQUEST_TIMEOUT, "WORKER_REQUEST_TIMEOUT");
console.log("Task timeout policy checks passed");
