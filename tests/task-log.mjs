import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setLogPath, createTurn, appendEvent, updateTurn, finalizeTurn, getTurn, flushLog } from "../server/task-log.mjs";

const logPath = join(tmpdir(), `mashang-hub-test-${randomUUID()}.jsonl`);
setLogPath(logPath);
const taskId = `task_${randomUUID()}`;

const root = createTurn({ conversationId: "hub_test", turnId: "turn_001", taskId, model: "deepseek/deepseek-flash" });
assert.equal(root.record, "turn");
assert.equal(root.status, "SUBMITTING");
assert.equal(root.terminalAt, null);

appendEvent(taskId, { event: "opencode.request.sent" });
appendEvent(taskId, { event: "opencode.progress", value: "busy" });
updateTurn(taskId, { openCodeSessionId: "ses_test" });

const turn = getTurn(taskId);
assert.equal(turn.events.length, 2);
assert.equal(turn.root.openCodeSessionId, "ses_test");

finalizeTurn(taskId, { event: "task.timeout", status: "TIMEOUT", reason: "WORKER_REQUEST_TIMEOUT", elapsedMs: 180042 });
assert.equal(turn.root.status, "TIMEOUT");
assert.equal(turn.root.terminalReason, "WORKER_REQUEST_TIMEOUT");
assert.ok(turn.root.terminalAt);

await flushLog();
const lines = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
assert.equal(lines[0].record, "turn");
assert.ok(lines.some((line) => line.event === "opencode.request.sent"));
assert.ok(lines.some((line) => line.event === "opencode.progress" && line.value === "busy"));
assert.ok(lines.some((line) => line.event === "task.timeout" && line.elapsedMs === 180042));
assert.ok(lines.filter((line) => line.record === "turn").every((line) => !("prompt" in line) && !("text" in line)));
console.log("Task turn log checks passed");
