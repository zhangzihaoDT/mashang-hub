import assert from "node:assert/strict";
import {
  CONTROL_OPS,
  CONTROL_TERMINAL_STATES,
  isValidControlOp,
  isTerminalControl,
  controlTimeoutConfig,
  sanitizeControlResult,
} from "../server/runtime-control.mjs";

assert.deepEqual([...CONTROL_OPS], ["up", "down", "restart", "run"]);
assert.equal(isValidControlOp("up"), true);
assert.equal(isValidControlOp("restart"), true);
assert.equal(isValidControlOp("stop"), false);

assert.deepEqual([...CONTROL_TERMINAL_STATES], ["COMPLETED", "FAILED", "REFUSED", "REJECTED", "TIMEOUT", "CANCELLED"]);
assert.equal(isTerminalControl("COMPLETED"), true);
assert.equal(isTerminalControl("RUNNING"), false);
assert.equal(isTerminalControl("AWAITING_PERMISSION"), false);

const defaults = controlTimeoutConfig({});
assert.equal(defaults.requestMs, 300000);
assert.equal(defaults.graceMs, 10000);
assert.deepEqual(controlTimeoutConfig({ CONTROL_TIMEOUT_MS: "5000", CONTROL_CANCEL_GRACE_MS: "1000" }), { requestMs: 5000, graceMs: 1000 });
assert.deepEqual(controlTimeoutConfig({ CONTROL_TIMEOUT_MS: "-1", CONTROL_CANCEL_GRACE_MS: "abc" }), { requestMs: 300000, graceMs: 10000 });
assert.deepEqual(controlTimeoutConfig({}, 900000), { requestMs: 900000, graceMs: 10000 });
assert.deepEqual(controlTimeoutConfig({}, 7200000), { requestMs: 3600000, graceMs: 10000 });
assert.equal(controlTimeoutConfig({ CONTROL_TIMEOUT_MS: "4000" }, 900000).requestMs, 4000, "explicit Hub timeout overrides Worker metadata");

assert.deepEqual(sanitizeControlResult({ status: "COMPLETED", reason: "OK" }), { status: "COMPLETED", reason: "OK", code: null });
assert.deepEqual(sanitizeControlResult({ status: "BOGUS", reason: "X" }), { status: "FAILED", reason: "X", code: null });
assert.deepEqual(sanitizeControlResult({ status: "FAILED", reason: "JOB_FAILED", code: 3 }), { status: "FAILED", reason: "JOB_FAILED", code: 3 });
assert.equal(sanitizeControlResult({ status: "REFUSED", reason: "x".repeat(200) }).reason.length, 64);
assert.deepEqual(sanitizeControlResult(null), { status: "FAILED", reason: "UNKNOWN", code: null });

console.log("Runtime control contract checks passed");
