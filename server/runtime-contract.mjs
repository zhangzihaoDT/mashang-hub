export const RUNTIME_PROTOCOL_VERSION = 1;
const SERVICE_STATUS = new Set(["ONLINE", "OFFLINE", "UNKNOWN"]);
const DEPENDENCY_STATUS = new Set(["ONLINE", "OFFLINE", "UNKNOWN"]);
const JOB_STATUS = new Set(["COMPLETED", "FAILED", "RUNNING", "UNKNOWN"]);
const OPERATION_STATUS = new Set(["IDLE", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]);
const MAX_ENTRIES = 128;
const MAX_STRING = 200;
const MAX_OPERATION_TIMEOUT_MS = 3600000;

function shortString(value) {
  return typeof value === "string" ? value.slice(0, MAX_STRING) : null;
}

function timestampOrNull(value) {
  return typeof value === "string" && value.length <= 40 ? value : null;
}

function safeOpenUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Validate and sanitize a Worker runtime.snapshot against the V1 contract.
 * Returns a clean object with only whitelisted fields, or null if unusable.
 */
export function sanitizeRuntimeSnapshot(message) {
  if (!message || message.type !== "runtime.snapshot" || message.protocolVersion !== RUNTIME_PROTOCOL_VERSION) return null;

  const services = (Array.isArray(message.services) ? message.services : [])
    .slice(0, MAX_ENTRIES)
    .map((service) => {
      const id = shortString(service?.id);
      if (!id) return null;
      const clean = {
        id,
        label: shortString(service.label) || id,
        status: SERVICE_STATUS.has(service.status) ? service.status : "UNKNOWN",
        managed: Boolean(service.managed),
      };
      const workspace = shortString(service.workspace);
      if (workspace) clean.workspace = workspace;
      const group = shortString(service.group);
      const summary = shortString(service.summary);
      if (group) clean.group = group;
      if (summary) clean.summary = summary;
      const openUrl = safeOpenUrl(service.openUrl);
      if (openUrl) clean.openUrl = openUrl;
      return clean;
    })
    .filter(Boolean);

  const dependencies = (Array.isArray(message.dependencies) ? message.dependencies : [])
    .slice(0, MAX_ENTRIES)
    .map((dependency) => {
      const id = shortString(dependency?.id);
      if (!id) return null;
      return {
        id,
        label: shortString(dependency.label) || id,
        status: DEPENDENCY_STATUS.has(dependency.status) ? dependency.status : "UNKNOWN",
      };
    })
    .filter(Boolean);

  const jobs = (Array.isArray(message.jobs) ? message.jobs : [])
    .slice(0, MAX_ENTRIES)
    .map((job) => {
      const id = shortString(job?.id);
      if (!id) return null;
      const lastRun = job.lastRun || {};
      const clean = {
        id,
        label: shortString(job.label) || id,
        lastRun: {
          status: JOB_STATUS.has(lastRun.status) ? lastRun.status : "UNKNOWN",
          startedAt: timestampOrNull(lastRun.startedAt),
          finishedAt: timestampOrNull(lastRun.finishedAt),
        },
      };
      const workspace = shortString(job.workspace);
      if (workspace) clean.workspace = workspace;
      const group = shortString(job.group);
      if (group) clean.group = group;
      return clean;
    })
    .filter(Boolean);

  const operations = (Array.isArray(message.operations) ? message.operations : [])
    .slice(0, MAX_ENTRIES)
    .map((operation) => {
      const id = shortString(operation?.id);
      if (!id) return null;
      const lastRun = operation.lastRun || {};
      const clean = {
        id,
        label: shortString(operation.label) || id,
        enabled: Boolean(operation.enabled),
        ...(operation.requiresSnapshot === true ? { requiresSnapshot: true } : {}),
        cancellationSupported: operation.cancellationSupported !== false,
        lastRun: {
          status: OPERATION_STATUS.has(lastRun.status) ? lastRun.status : "UNKNOWN",
          startedAt: timestampOrNull(lastRun.startedAt),
          finishedAt: timestampOrNull(lastRun.finishedAt),
          code: Number.isInteger(lastRun.code) ? lastRun.code : null,
        },
      };
      const workspace = shortString(operation.workspace);
      if (workspace) clean.workspace = workspace;
      const group = shortString(operation.group);
      const description = shortString(operation.description);
      if (group) clean.group = group;
      if (description) clean.description = description;
      if (Number.isInteger(operation.timeoutMs) && operation.timeoutMs > 0) {
        clean.timeoutMs = Math.min(operation.timeoutMs, MAX_OPERATION_TIMEOUT_MS);
      }
      const summary = shortString(lastRun.summary);
      if (summary) clean.lastRun.summary = summary;
      return clean;
    })
    .filter(Boolean);

  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    workerId: shortString(message.workerId),
    sequence: Number.isInteger(message.sequence) ? message.sequence : null,
    generatedAt: timestampOrNull(message.generatedAt),
    dependencies,
    services,
    jobs,
    operations,
  };
}
