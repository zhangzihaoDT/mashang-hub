export const RUNTIME_PROTOCOL_VERSION = 1;
const SERVICE_STATUS = new Set(["ONLINE", "OFFLINE", "UNKNOWN"]);
const JOB_STATUS = new Set(["COMPLETED", "FAILED", "RUNNING", "UNKNOWN"]);
const MAX_ENTRIES = 128;
const MAX_STRING = 200;

function shortString(value) {
  return typeof value === "string" ? value.slice(0, MAX_STRING) : null;
}

function timestampOrNull(value) {
  return typeof value === "string" && value.length <= 40 ? value : null;
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
      return {
        id,
        label: shortString(service.label) || id,
        status: SERVICE_STATUS.has(service.status) ? service.status : "UNKNOWN",
        managed: Boolean(service.managed),
      };
    })
    .filter(Boolean);

  const jobs = (Array.isArray(message.jobs) ? message.jobs : [])
    .slice(0, MAX_ENTRIES)
    .map((job) => {
      const id = shortString(job?.id);
      if (!id) return null;
      const lastRun = job.lastRun || {};
      return {
        id,
        label: shortString(job.label) || id,
        lastRun: {
          status: JOB_STATUS.has(lastRun.status) ? lastRun.status : "UNKNOWN",
          startedAt: timestampOrNull(lastRun.startedAt),
          finishedAt: timestampOrNull(lastRun.finishedAt),
        },
      };
    })
    .filter(Boolean);

  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    workerId: shortString(message.workerId),
    sequence: Number.isInteger(message.sequence) ? message.sequence : null,
    generatedAt: timestampOrNull(message.generatedAt),
    services,
    jobs,
  };
}
