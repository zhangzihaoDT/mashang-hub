import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { httpProbe, processProbe, isPidAlive, findProcesses } from "./probes.mjs";
import { readDailyJob, readManualJob, readManualOperation, pickLatestRun } from "./jobs.mjs";

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
    workspace: service.workspace ?? null,
    label: service.label,
    group: service.group ?? null,
    summary: service.summary ?? null,
    openUrl: service.openUrl ?? null,
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

async function probeDependency(dependency, options = {}) {
  const result = await runServiceProbe(dependency, options);
  return {
    id: dependency.id,
    label: dependency.label,
    online: Boolean(result.online),
    detail: result.detail,
    latencyMs: result.latencyMs ?? null,
  };
}

export async function collectStatus(registry, options = {}) {
  const probeOptions = {
    timeoutMs: registry.probeTimeoutMs || 2500,
    stateDir: registry.runtimeDir,
    ...options,
  };

  const services = await Promise.all(registry.services.map((service) => probeService(service, probeOptions)));
  const dependencies = await Promise.all((registry.dependencies || []).map((dependency) => probeDependency(dependency, probeOptions)));

  const jobs = await Promise.all(
    registry.jobs.map(async (job) => {
      const scheduled = job.probe.type === "scheduler-log"
        ? await readDailyJob(job.probe)
        : { status: "UNKNOWN", reason: `unsupported probe: ${job.probe.type}`, startedAt: null, finishedAt: null };
      const manual = await readManualJob(registry.runtimeDir, job.id);
      const result = pickLatestRun(scheduled, manual) || scheduled;
      return {
        id: job.id,
        workspace: job.workspace ?? null,
        label: job.label,
        group: job.group ?? null,
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

  const operations = await Promise.all((registry.operations || []).map(async (operation) => {
    const scheduled = operation.probe?.type === "scheduler-log"
      ? await readDailyJob(operation.probe)
      : null;
    const manual = await readManualOperation(registry.runtimeDir, operation.id);
    const result = pickLatestRun(scheduled, manual) || { status: "IDLE" };
    return {
      id: operation.id,
      workspace: operation.workspace ?? null,
      label: operation.label,
      group: operation.group ?? null,
      description: operation.description || "",
      enabled: operation.enabled !== false && Boolean(operation.run || operation.requiresSnapshot),
      requiresSnapshot: operation.requiresSnapshot === true,
      cancellationSupported: operation.cancellationSupported !== false,
      timeoutMs: Number.isInteger(operation.timeoutMs) ? operation.timeoutMs : null,
      lastRun: {
        status: result.status || "IDLE",
        startedAt: result.startedAt ?? null,
        finishedAt: result.finishedAt ?? null,
        code: Number.isInteger(result.code) ? result.code : null,
        summary: result.summary ?? null,
      },
    };
  }));

  return { checkedAt: new Date().toISOString(), dependencies, services, jobs, operations };
}
