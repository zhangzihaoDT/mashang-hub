export const REASONS = Object.freeze({
  WORKER_REQUEST_TIMEOUT: "WORKER_REQUEST_TIMEOUT",
  EMPTY_RESULT: "EMPTY_RESULT",
  WORKER_DISCONNECTED: "WORKER_DISCONNECTED",
  USER_CANCELLED: "USER_CANCELLED",
  OPENCODE_ERROR: "OPENCODE_ERROR",
});

export const TERMINAL_STATES = Object.freeze(["COMPLETED", "FAILED", "INTERRUPTED", "TIMEOUT", "CANCELLED"]);
const terminalSet = new Set(TERMINAL_STATES);
export function isTerminal(status) { return terminalSet.has(status); }

const DEFAULT_REQUEST_MS = 180000;
const DEFAULT_GRACE_MS = 10000;

export function timeoutConfig(env = process.env) {
  const requestMs = Number(env.TASK_TIMEOUT_MS ?? DEFAULT_REQUEST_MS);
  const graceMs = Number(env.TASK_CANCEL_GRACE_MS ?? DEFAULT_GRACE_MS);
  return {
    requestMs: Number.isFinite(requestMs) && requestMs > 0 ? requestMs : DEFAULT_REQUEST_MS,
    graceMs: Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_GRACE_MS,
  };
}

export function softDeadline(startedAt, config = timeoutConfig()) { return startedAt + config.requestMs; }
export function hardDeadline(startedAt, config = timeoutConfig()) { return startedAt + config.requestMs + config.graceMs; }
