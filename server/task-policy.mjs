const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
export function executionPolicy(input = {}, env = process.env) {
  input = input && typeof input === 'object' ? input : {};
  const maximum = positive(env.TASK_MAX_EXECUTION_MS, 86400000);
  const executionClass = input.executionClass === 'verified' ? 'verified' : 'query';
  const defaultDeadline = executionClass === 'verified'
    ? positive(env.TASK_VERIFIED_EXECUTION_DEADLINE_MS, 1800000)
    : positive(env.TASK_EXECUTION_DEADLINE_MS ?? env.TASK_TIMEOUT_MS, 900000);
  return {
    executionClass,
    allowClassPromotion: input.executionClass == null && input.executionDeadlineMs == null,
    requiresApproval: false, retry: 'manual',
    executionDeadlineMs: Math.min(positive(input.executionDeadlineMs, defaultDeadline), maximum),
    progressTimeoutMs: positive(input.progressTimeoutMs, positive(env.TASK_PROGRESS_TIMEOUT_MS, 180000)),
    progressAction: 'notify',
  };
}
export function executionTimes(record, now = Date.now()) {
  if (!record.startedAt) return { remainingMs: null, stalled: false };
  return { remainingMs: Math.max(0, record.startedAt + record.policy.executionDeadlineMs - now), stalled: now - (record.lastProgressAt || record.startedAt) >= record.policy.progressTimeoutMs };
}
