import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_LINE = /^\[([^\]]+)\]\s*(.*)$/;
const STEP_START = /^▶\s+(\S+):/;
const STEP_RESULT = /^■\s+(\S+)\s+exit=(-?\d+)$/;
const STEP_SKIP = /^跳过\s+(\S+?)：/;
const DATED_LOG = /^\d{4}-\d{2}-\d{2}\.log$/;
const JOB_STATE_DIR = "jobs";

/**
 * Parse one scheduler log file and return the most recent daily-pipeline run.
 * The daily pipeline is uniquely identified by its first step (`refresh_full`).
 * Pure function → easy to test without touching the filesystem.
 */
export function parseSchedulerLog(text, steps) {
  const first = steps[0];
  const lines = String(text || "").split(/\r?\n/);

  let startIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].match(LOG_LINE);
    if (line && STEP_START.exec(line[2])?.[1] === first) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) return { status: "UNKNOWN", reason: "no daily run found", steps: [], skipped: [] };

  const startedAt = lines[startIndex].match(LOG_LINE)?.[1] ?? null;
  const results = [];
  const skipped = [];
  let finishedAt = null;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i].match(LOG_LINE);
    if (!line) continue;
    const [, timestamp, message] = line;

    const result = STEP_RESULT.exec(message);
    if (result) {
      results.push({ name: result[1], exitCode: Number(result[2]), at: timestamp });
      finishedAt = timestamp;
      // A new start of the first step means a fresh pipeline; stop here.
      continue;
    }
    const skip = STEP_SKIP.exec(message);
    if (skip) skipped.push({ name: skip[1], at: timestamp });
    if (i > startIndex && STEP_START.exec(message)?.[1] === first) break;
  }

  const failed = results.find((step) => step.exitCode !== 0);
  const completed = new Set(results.map((step) => step.name));
  const allDone = steps.every((step) => completed.has(step));

  let status = "RUNNING";
  if (failed) status = "FAILED";
  else if (allDone) status = "COMPLETED";

  return {
    status,
    startedAt,
    finishedAt,
    failedStep: failed?.name ?? null,
    failedExitCode: failed?.exitCode ?? null,
    steps: results,
    skipped,
  };
}

async function listDatedLogs(logDir) {
  try {
    const entries = await readdir(logDir);
    return entries.filter((name) => DATED_LOG.test(name)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Read the newest daily-pipeline result from the scheduler log directory.
 * Walks dated files newest-first until a file contains a daily run.
 */
export async function readDailyJob(spec) {
  const steps = spec.steps || [];
  const files = await listDatedLogs(spec.logDir);
  for (const file of files) {
    let text;
    try {
      text = await readFile(join(spec.logDir, file), "utf8");
    } catch {
      continue;
    }
    const run = parseSchedulerLog(text, steps);
    if (run.status !== "UNKNOWN") return { ...run, source: join(spec.logDir, file), logDate: file.replace(/\.log$/, "") };
  }
  return { status: "UNKNOWN", reason: `no daily run found in ${spec.logDir}`, steps: [], skipped: [], source: spec.logDir };
}

function toEpoch(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * Read the last manual (`runtime.control` run) result persisted under
 * `<stateDir>/jobs/<id>.json`. This is Worker-local state; it never crosses
 * the Hub protocol and only feeds `lastRun`.
 */
export async function readManualJob(stateDir, id) {
  if (!stateDir || !id) return null;
  try {
    const record = JSON.parse(await readFile(join(stateDir, JOB_STATE_DIR, `${id}.json`), "utf8"));
    if (!record || typeof record.status !== "string") return null;
    return {
      status: record.status,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      code: Number.isInteger(record.code) ? record.code : null,
      source: JOB_STATE_DIR,
    };
  } catch {
    return null;
  }
}

/** Persist a manual run record so it survives a Worker restart. */
export async function writeManualJob(stateDir, id, record) {
  if (!stateDir || !id) return null;
  const stored = {
    status: record.status,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    code: Number.isInteger(record.code) ? record.code : null,
  };
  const dir = join(stateDir, JOB_STATE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return stored;
}

/**
 * Choose the most recent real execution between the scheduler-derived run and
 * the manual run. Primary key is `startedAt`, tie-broken by `finishedAt`.
 */
export function pickLatestRun(scheduled, manual) {
  if (!scheduled) return manual || null;
  if (!manual) return scheduled;
  const scheduledStart = toEpoch(scheduled.startedAt);
  const manualStart = toEpoch(manual.startedAt);
  if (scheduledStart === null && manualStart === null) return scheduled;
  if (scheduledStart === null) return manual;
  if (manualStart === null) return scheduled;
  if (manualStart !== scheduledStart) return manualStart > scheduledStart ? manual : scheduled;
  const scheduledEnd = toEpoch(scheduled.finishedAt);
  const manualEnd = toEpoch(manual.finishedAt);
  return (manualEnd ?? -Infinity) >= (scheduledEnd ?? -Infinity) ? manual : scheduled;
}
