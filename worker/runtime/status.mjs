import { httpProbe, processProbe } from "./probes.mjs";
import { readDailyJob } from "./jobs.mjs";

async function runServiceProbe(probe, options) {
  if (probe.type === "http") return httpProbe(probe, options);
  if (probe.type === "process") return processProbe(probe);
  return { online: false, detail: `unsupported probe: ${probe.type}` };
}

async function runJobProbe(probe) {
  if (probe.type === "scheduler-log") return readDailyJob(probe);
  return { status: "UNKNOWN", reason: `unsupported probe: ${probe.type}` };
}

export async function collectStatus(registry, options = {}) {
  const probeOptions = { timeoutMs: registry.probeTimeoutMs || 2500, ...options };

  const services = await Promise.all(
    registry.services.map(async (service) => {
      const result = await runServiceProbe(service.probe, probeOptions);
      return {
        id: service.id,
        label: service.label,
        category: service.category || "service",
        description: service.description || "",
        online: Boolean(result.online),
        detail: result.detail,
        latencyMs: result.latencyMs ?? null,
        url: result.url ?? null,
        pid: result.pid ?? null,
      };
    }),
  );

  const jobs = await Promise.all(
    registry.jobs.map(async (job) => {
      const result = await runJobProbe(job.probe);
      return {
        id: job.id,
        label: job.label,
        description: job.description || "",
        status: result.status,
        startedAt: result.startedAt ?? null,
        finishedAt: result.finishedAt ?? null,
        failedStep: result.failedStep ?? null,
        failedExitCode: result.failedExitCode ?? null,
        steps: result.steps || [],
        skipped: result.skipped || [],
        reason: result.reason ?? null,
        source: result.source || null,
      };
    }),
  );

  return { checkedAt: new Date().toISOString(), services, jobs };
}
