const terminalStates = new Set(["COMPLETED", "FAILED", "INTERRUPTED", "TIMEOUT", "CANCELLED"]);
const rank = { IDLE: 0, SUBMITTING: 1, UNDERSTANDING: 1, PLANNING: 1, RUNNING: 2, WAITING_PERMISSION: 2, RENDERING: 3, COMPLETED: 4, FAILED: 4, INTERRUPTED: 4, TIMEOUT: 4, CANCELLED: 4 };
const eventState = {
  "task.submit": "UNDERSTANDING",
  "task.accepted": "UNDERSTANDING",
  "task.running": "RUNNING",
  "agent.message.completed": "RENDERING",
  "task.completed": "COMPLETED",
  "task.failed": "FAILED",
  "task.timeout": "TIMEOUT",
  "task.cancelled": "CANCELLED",
  "task.interrupted": "INTERRUPTED",
};

export function isTerminalTaskState(status) { return terminalStates.has(status); }

export function transitionTaskState(current, event) {
  if (!event.taskId) return current;
  if (current.taskId && current.taskId !== event.taskId) return current;
  if (terminalStates.has(current.status)) return current;
  const next = eventState[event.type];
  if (!next) return current;
  if ((rank[next] ?? 0) < (rank[current.status] ?? 0)) return current;
  return { taskId: event.taskId, status: next };
}
