import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

let logPath = process.env.HUB_TURN_LOG || join(homedir(), ".mashang-hub", "turns.jsonl");
const turns = new Map();
let writeChain = Promise.resolve();

export function setLogPath(path) { logPath = path; }
export function flushLog() { return writeChain; }

function write(line) {
  writeChain = writeChain
    .then(() => appendFile(logPath, `${JSON.stringify(line)}\n`))
    .catch(() => { /* Log persistence must never break the control plane. */ });
}

function nowISO() { return new Date().toISOString(); }

export function createTurn({ conversationId, turnId, taskId, model }) {
  const now = nowISO();
  const root = {
    record: "turn",
    conversationId,
    turnId,
    taskId,
    openCodeSessionId: null,
    model,
    status: "SUBMITTING",
    startedAt: now,
    lastEventAt: now,
    terminalAt: null,
    terminalReason: null,
  };
  turns.set(taskId, { root, events: [] });
  write(root);
  return root;
}

export function appendEvent(taskId, event) {
  const turn = turns.get(taskId);
  if (!turn) return null;
  const line = { record: "event", taskId, ts: nowISO(), ...event };
  turn.events.push(line);
  turn.root.lastEventAt = line.ts;
  write(line);
  return line;
}

export function updateTurn(taskId, patch) {
  const turn = turns.get(taskId);
  if (!turn) return null;
  Object.assign(turn.root, patch, { lastEventAt: nowISO() });
  return turn.root;
}

export function finalizeTurn(taskId, { event, status, reason, elapsedMs }) {
  const turn = turns.get(taskId);
  if (!turn) return null;
  const ts = nowISO();
  turn.root.status = status;
  turn.root.lastEventAt = ts;
  turn.root.terminalAt = ts;
  turn.root.terminalReason = reason || null;
  const line = { record: "event", taskId, ts, event, status, reason: reason || null, elapsedMs };
  turn.events.push(line);
  write(line);
  write({ ...turn.root });
  return turn;
}

export function getTurn(taskId) { return turns.get(taskId) || null; }
