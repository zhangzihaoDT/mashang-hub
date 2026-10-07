export const CONTROL_OPS = Object.freeze(["up", "down", "restart", "run"]);
export const CONTROL_TERMINAL_STATES = Object.freeze(["COMPLETED", "FAILED", "REFUSED", "REJECTED", "TIMEOUT", "CANCELLED"]);
const terminalSet = new Set(CONTROL_TERMINAL_STATES);
const opSet = new Set(CONTROL_OPS);

export function isValidControlOp(op) { return opSet.has(op); }
export function isTerminalControl(status) { return terminalSet.has(status); }

const DEFAULT_CONTROL_TIMEOUT_MS = 300000;
const DEFAULT_CONTROL_GRACE_MS = 10000;

export function controlTimeoutConfig(env = process.env, suggestedRequestMs = null) {
  const configuredRequestMs = Number(env.CONTROL_TIMEOUT_MS);
  const suggested = Number(suggestedRequestMs);
  const requestMs = Number.isFinite(configuredRequestMs) && configuredRequestMs > 0
    ? configuredRequestMs
    : Number.isFinite(suggested) && suggested > 0
      ? Math.min(suggested, 3600000)
      : DEFAULT_CONTROL_TIMEOUT_MS;
  const graceMs = Number(env.CONTROL_CANCEL_GRACE_MS ?? DEFAULT_CONTROL_GRACE_MS);
  return {
    requestMs,
    graceMs: Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_CONTROL_GRACE_MS,
  };
}

/**
 * Sanitize a Worker runtime.control.result into a generic terminal update.
 * Only a stable status + machine reason code + optional exit code survive.
 */
export function sanitizeControlResult(message) {
  const allowed = new Set(["COMPLETED", "FAILED", "REFUSED", "CANCELLED"]);
  const status = allowed.has(message?.status) ? message.status : "FAILED";
  const reason = typeof message?.reason === "string" && message.reason.length > 0 ? message.reason.slice(0, 64) : "UNKNOWN";
  const code = Number.isInteger(message?.code) ? message.code : null;
  return { status, reason, code };
}
