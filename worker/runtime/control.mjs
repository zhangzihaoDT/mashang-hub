import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { probeService } from "./status.mjs";
import { findProcesses, isPidAlive } from "./probes.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findService(registry, id) {
  return (registry.services || []).find((service) => service.id === id) || null;
}

export function findJob(registry, id) {
  return (registry.jobs || []).find((job) => job.id === id) || null;
}

function runToCompletion(spec, { stdio = "inherit", signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env || {}) },
      stdio,
    });
    let killTimer = null;
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 3000);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (value) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    child.on("error", (error) => finish({ code: null, signal: null, error: error.message, aborted: Boolean(signal?.aborted) }));
    child.on("exit", (code, signalName) => finish({ code, signal: signalName, error: null, aborted: Boolean(signal?.aborted) }));
  });
}

async function spawnDetached(spec, logFile) {
  await mkdir(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(spec.command, spec.args || [], {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env || {}) },
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

async function terminate(pid, { group, signal = "SIGTERM", timeoutMs = 8000 }) {
  const send = (sig) => {
    try {
      process.kill(group ? -pid : pid, sig);
    } catch {
      /* Process already gone. */
    }
  };
  send(signal);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPidAlive(pid))) return true;
    await sleep(200);
  }
  send("SIGKILL");
  await sleep(300);
  return !(await isPidAlive(pid));
}

async function readManaged(stateDir, id) {
  if (!stateDir) return null;
  try {
    return JSON.parse(await readFile(join(stateDir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeManaged(stateDir, id, record) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function clearManaged(stateDir, id) {
  try {
    await unlink(join(stateDir, `${id}.json`));
  } catch {
    /* Already absent. */
  }
}

function probeOptions(registry) {
  return { timeoutMs: registry.probeTimeoutMs, stateDir: registry.runtimeDir };
}

async function waitForService(service, registry, predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { aborted: true };
    last = await probeService(service, probeOptions(registry));
    if (predicate(last)) return last;
    await sleep(400);
  }
  return null;
}

async function canonicalPids(service) {
  if (!service.match) return [];
  return (await findProcesses(service.match)).map((entry) => entry.pid);
}

/**
 * Start a service using its declared canonical entry, then verify it is online.
 * Refuses to treat legacy processes as the service; if canonical is already
 * running it is a no-op so a retired entry is never "re-legitimized".
 */
export async function up(service, registry, { log = console, signal } = {}) {
  if (signal?.aborted) return { status: "cancelled" };
  const stateDir = registry.runtimeDir;
  const before = await probeService(service, probeOptions(registry));

  if (before.legacy.length) {
    const list = before.legacy.map((entry) => `pid ${entry.pid} (${entry.command})`).join("; ");
    log.warn(`warning: legacy process detected for ${service.id}: ${list}. It is not a valid ${service.id}.`);
  }
  if (before.online) {
    return { status: "already-running", managed: before.managed, before };
  }

  const start = service.control?.start;
  if (!start) throw new Error(`service '${service.id}' has no start control declared in the registry`);

  let record = null;
  if (start.detach) {
    const logFile = start.logFile || join(stateDir, `${service.id}.log`);
    const pid = await spawnDetached(start, logFile);
    record = {
      id: service.id,
      pid,
      pgid: pid,
      command: start.command,
      args: start.args || [],
      cwd: start.cwd || null,
      logFile,
      startedAt: new Date().toISOString(),
    };
    await writeManaged(stateDir, service.id, record);
    log.log(`started ${service.id} (pid ${pid}) → ${logFile}`);
  } else {
    log.log(`running ${service.id} start: ${start.command} ${(start.args || []).join(" ")}`.trim());
    const result = await runToCompletion(start, { signal });
    if (result.aborted || signal?.aborted) return { status: "cancelled", before };
    if (result.code !== 0) return { status: "start-failed", code: result.code, error: result.error, before };
  }

  const after = await waitForService(service, registry, (state) => state.online, registry.verifyMs, signal);
  if (after?.aborted || signal?.aborted) return { status: "cancelled", record, before };
  if (!after) return { status: "unverified", record, before };

  if (record) await writeManaged(stateDir, service.id, { ...record, verifiedPid: after.pid ?? null });
  return { status: "started", record, before, after };
}

/**
 * Stop a service. Prefers the declared stop command, then the managed record,
 * then the canonical process signature. Never stops a legacy-only process.
 */
export async function down(service, registry, { log = console, signal } = {}) {
  if (signal?.aborted) return { status: "cancelled" };
  const stateDir = registry.runtimeDir;
  const stop = service.control?.stop || {};
  const before = await probeService(service, probeOptions(registry));

  if (!before.online) {
    const record = await readManaged(stateDir, service.id);
    if (record && !(await isPidAlive(record.pid))) await clearManaged(stateDir, service.id);
    if (before.legacy.length) {
      return { status: "refused", reason: "legacy process detected; not a managed service", before };
    }
    return { status: "already-stopped", before };
  }

  const signalName = stop.signal || "SIGTERM";
  const timeoutMs = stop.timeoutMs || 8000;
  const record = await readManaged(stateDir, service.id);

  if (record && (await isPidAlive(record.pid))) {
    log.log(`stopping managed ${service.id} (pid ${record.pid})`);
    await terminate(record.pid, { group: true, signal: signalName, timeoutMs });
    await clearManaged(stateDir, service.id);
  } else if (stop.command) {
    log.log(`running ${service.id} stop: ${stop.command} ${(stop.args || []).join(" ")}`.trim());
    const result = await runToCompletion(stop, { signal });
    if (result.aborted || signal?.aborted) return { status: "cancelled", before };
    if (result.code !== 0) return { status: "stop-failed", code: result.code, error: result.error, before };
    await clearManaged(stateDir, service.id);
  } else {
    const pids = before.pids.length ? before.pids : await canonicalPids(service);
    if (!pids.length) {
      return { status: "refused", reason: "no managed instance and no stop command; refusing to guess", before };
    }
    log.log(`stopping canonical ${service.id} (pid ${pids.join(", ")})`);
    for (const pid of pids) await terminate(pid, { group: false, signal: signalName, timeoutMs });
    await clearManaged(stateDir, service.id);
  }

  const after = await waitForService(service, registry, (state) => !state.online, registry.verifyMs, signal);
  if (after?.aborted || signal?.aborted) return { status: "cancelled", before };
  if (!after) return { status: "unverified", before };
  return { status: "stopped", before };
}

export async function restart(service, registry, options = {}) {
  const stopped = await down(service, registry, options);
  if (["refused", "stop-failed", "cancelled"].includes(stopped.status)) return { status: stopped.status, down: stopped };
  await sleep(500);
  const started = await up(service, registry, options);
  return { status: started.status, down: stopped, up: started };
}

/** Run a job once with its declared canonical entry. */
export async function run(job, registry, { log = console, signal } = {}) {
  const spec = job.control?.run;
  if (!spec) throw new Error(`job '${job.id}' has no run control declared in the registry`);
  log.log(`running job ${job.id}: ${spec.command} ${(spec.args || []).join(" ")}`.trim());
  const result = await runToCompletion(spec, { stdio: "inherit", signal });
  if (result.aborted || signal?.aborted) return { status: "cancelled", code: result.code, job };
  return { status: result.code === 0 ? "completed" : "failed", code: result.code, signal: result.signal, job };
}

function mapServiceResult(result) {
  const status = result.status;
  if (status === "cancelled") return { status: "CANCELLED", reason: "CANCELLED" };
  if (status === "refused") return { status: "REFUSED", reason: "REFUSED" };
  if (["started", "already-running", "stopped", "already-stopped"].includes(status)) return { status: "COMPLETED", reason: "OK" };
  if (status === "unverified") return { status: "FAILED", reason: "UNVERIFIED" };
  if (status === "start-failed" || status === "stop-failed") return { status: "FAILED", reason: "EXEC_FAILED", code: result.code ?? null };
  return { status: "FAILED", reason: "UNKNOWN" };
}

/**
 * Execute a generic runtime control operation against the registry.
 * Returns only business-neutral fields: status + stable reason code (+ exit code).
 */
export async function executeControl(registry, { op, targetId, signal, log = console } = {}) {
  if (op === "run") {
    const job = findJob(registry, targetId);
    if (!job) return { status: "REFUSED", reason: "UNKNOWN_TARGET" };
    if (!job.control?.run) return { status: "REFUSED", reason: "NO_RUN_ENTRY" };
    const result = await run(job, registry, { log, signal });
    if (result.status === "cancelled") return { status: "CANCELLED", reason: "CANCELLED" };
    return result.status === "completed"
      ? { status: "COMPLETED", reason: "OK", code: result.code ?? null }
      : { status: "FAILED", reason: "JOB_FAILED", code: result.code ?? null };
  }
  if (!["up", "down", "restart"].includes(op)) return { status: "REFUSED", reason: "UNKNOWN_OP" };
  const service = findService(registry, targetId);
  if (!service) return { status: "REFUSED", reason: "UNKNOWN_TARGET" };
  const handler = op === "up" ? up : op === "down" ? down : restart;
  const result = await handler(service, registry, { log, signal });
  return mapServiceResult(result);
}
