import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpProbe, processProbe, isPidAlive, findProcesses } from "./probes.mjs";
import { readDailyJob } from "./jobs.mjs";

async function runServiceProbe(service, options) {
  const probe = service.probe;
  if (probe.type === "http") return httpProbe(probe, options);
  if (probe.type === "process") return processProbe({ ...probe, match: service.match || probe.match });
  return { online: false, detail: `unsupported probe: ${probe.type}` };
}

async function readManagedRecord(stateDir, id) {
  if (!stateDir) return null;
  try {
    return JSON.parse(await readFile(join(stateDir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function detectLegacy(service) {
  const patterns = service.legacy || [];
  const found = [];
  for (const pattern of patterns) {
    for (const entry of await findProcesses(pattern)) found.push({ pattern, pid: entry.pid, command: entry.command });
  }
  return found;
}

/** Probe one service, enriched with managed-instance and legacy-process state. */
export async function probeService(service, options = {}) {
  const result = await runServiceProbe(service, options);
  const record = await readManagedRecord(options.stateDir, service.id);
  const managed = Boolean(record && (await isPidAlive(record.pid)));
  const legacy = await detectLegacy(service);
  return {
    id: service.id,
    label: service.label,
    category: service.category || "service",
    description: service.description || "",
    online: Boolean(result.online),
    managed,
    legacy,
    detail: result.detail,
    latencyMs: result.latencyMs ?? null,
    url: result.url ?? null,
    pid: result.pid ?? null,
    pids: result.pids ?? (result.pid ? [result.pid] : []),
  };
}

export async function collectStatus(registry, options = {}) {
  const probeOptions = {
    timeoutMs: registry.probeTimeoutMs || 2500,
    stateDir: registry.runtimeDir,
    ...options,
  };

  const services = await Promise.all(registry.services.map((service) => probeService(service, probeOptions)));

  const jobs = await Promise.all(
    registry.jobs.map(async (job) => {
      const result = job.probe.type === "scheduler-log" ? await readDailyJob(job.probe) : { status: "UNKNOWN", reason: `unsupported probe: ${job.probe.type}` };
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
