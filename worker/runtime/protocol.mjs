import { collectStatus } from "./status.mjs";

export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Map the local status model to the generic Worker→Hub snapshot.
 * Only whitelisted fields cross the boundary: no paths, commands, PIDs,
 * URLs, raw errors or legacy internals.
 */
export function snapshotFromStatus(status, { workerId, sequence, generatedAt = new Date().toISOString() }) {
  return {
    type: "runtime.snapshot",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    workerId,
    sequence,
    generatedAt,
    services: (status.services || []).map((service) => ({
      id: service.id,
      label: service.label,
      status: service.online ? "ONLINE" : "OFFLINE",
      managed: Boolean(service.managed),
    })),
    jobs: (status.jobs || []).map((job) => ({
      id: job.id,
      label: job.label,
      lastRun: {
        status: job.status || "UNKNOWN",
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      },
    })),
  };
}

export async function buildRuntimeSnapshot(registry, { workerId, sequence }) {
  const status = await collectStatus(registry);
  return snapshotFromStatus(status, { workerId, sequence });
}
