import assert from "node:assert/strict";
import { transitionTaskState } from "../public/task-state.js";

const taskId = "task-test";

// Normal happy path: understanding -> running -> rendering -> completed.
let state = { taskId, status: "UNDERSTANDING" };
state = transitionTaskState(state, { type: "task.running", taskId });
assert.equal(state.status, "RUNNING");
state = transitionTaskState(state, { type: "agent.message.completed", taskId });
assert.equal(state.status, "RENDERING");
state = transitionTaskState(state, { type: "task.completed", taskId });
assert.equal(state.status, "COMPLETED");

// Late running after completed must not regress.
state = transitionTaskState(state, { type: "task.running", taskId });
assert.equal(state.status, "COMPLETED");

// Late accepted must not regress a running task.
state = { taskId, status: "RUNNING" };
state = transitionTaskState(state, { type: "task.accepted", taskId });
assert.equal(state.status, "RUNNING");

// Failed is terminal and protects against late running.
state = { taskId, status: "RUNNING" };
state = transitionTaskState(state, { type: "task.failed", taskId });
assert.equal(state.status, "FAILED");
state = transitionTaskState(state, { type: "task.running", taskId });
assert.equal(state.status, "FAILED");

// Interrupted is terminal.
state = { taskId, status: "RUNNING" };
state = transitionTaskState(state, { type: "task.interrupted", taskId });
assert.equal(state.status, "INTERRUPTED");
state = transitionTaskState(state, { type: "task.running", taskId });
assert.equal(state.status, "INTERRUPTED");

// Timeout is terminal.
state = { taskId, status: "RUNNING" };
state = transitionTaskState(state, { type: "task.timeout", taskId });
assert.equal(state.status, "TIMEOUT");
state = transitionTaskState(state, { type: "task.running", taskId });
assert.equal(state.status, "TIMEOUT");

// Cancelled is terminal, and first valid terminal wins.
state = { taskId, status: "RUNNING" };
state = transitionTaskState(state, { type: "task.cancelled", taskId });
assert.equal(state.status, "CANCELLED");
state = transitionTaskState(state, { type: "task.completed", taskId });
assert.equal(state.status, "CANCELLED");

// A different taskId must not steal the active task.
state = { taskId, status: "RUNNING" };
assert.deepEqual(transitionTaskState(state, { type: "task.running", taskId: "other-task" }), state);
assert.deepEqual(transitionTaskState(state, { type: "task.running" }), state);
console.log("Task state machine regression checks passed");
