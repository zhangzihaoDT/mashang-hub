import { collectStatus } from "./status.mjs";

export const RUNTIME_PROTOCOL_VERSION = 1;

/**
 * Map the local status model to the generic Worker→Hub snapshot.
 * Only whitelisted fields cross the boundary: no paths, commands, PIDs,
 * probe URLs, raw errors or legacy internals. `openUrl` is an explicit
 * user-facing service entry point from the local registry.
 */
export function snapshotFromStatus(status, { workerId, sequence, generatedAt = new Date().toISOString() }) {
  return {
    type: "runtime.snapshot",
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    workerId,
    sequence,
    generatedAt,
    dependencies: (status.dependencies || []).map((dependency) => ({
      id: dependency.id,
      label: dependency.label,
      status: dependency.online ? "ONLINE" : "OFFLINE",
    })),
    services: (status.services || []).map((service) => ({
      id: service.id,
      label: service.label,
      status: service.online ? "ONLINE" : "OFFLINE",
      managed: Boolean(service.managed),
      ...(typeof service.group === "string" ? { group: service.group } : {}),
      ...(typeof service.summary === "string" ? { summary: service.summary } : {}),
      ...(typeof service.openUrl === "string" ? { openUrl: service.openUrl } : {}),
    })),
    jobs: (status.jobs || []).map((job) => ({
      id: job.id,
      label: job.label,
      ...(typeof job.group === "string" ? { group: job.group } : {}),
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
