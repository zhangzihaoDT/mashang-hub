import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchedulerLog, readDailyJob, readManualJob, readManualOperation, writeManualJob, pickLatestRun } from "../worker/runtime/jobs.mjs";
import { DAILY_PIPELINE_STARTS, DAILY_PIPELINE_STEPS } from "../worker/runtime/registry.mjs";

const steps = [...DAILY_PIPELINE_STEPS];
const startSteps = [...DAILY_PIPELINE_STARTS];

const completedLog = [
  "[2026-10-04 08:00:00] ▶ monitor: python vehicle_sales_monitor.py",
  "[2026-10-04 08:00:05] ■ monitor exit=0",
  "[2026-10-04 09:00:03] ▶ refresh_full: python update_all_datasets.py",
  "[2026-10-04 09:00:03] ■ refresh_full exit=0",
  "[2026-10-04 09:00:03] ▶ dataset_validate: python dataset_validate.py",
  "[2026-10-04 09:00:03] ■ dataset_validate exit=0",
  "[2026-10-04 09:00:03] ▶ daily_observation_sync: python skills_order_observation_daily.py",
  "[2026-10-04 09:00:03] ■ daily_observation_sync exit=0",
  "[2026-10-04 09:00:03] ▶ monitor: python vehicle_sales_monitor.py --refresh-ts ...",
  "[2026-10-04 09:00:03] ■ monitor exit=0",
].join("\n");

const completed = parseSchedulerLog(completedLog, steps);
assert.equal(completed.status, "COMPLETED");
assert.equal(completed.startedAt, "2026-10-04 09:00:03");
assert.equal(completed.finishedAt, "2026-10-04 09:00:03");
assert.equal(completed.failedStep, null);
assert.equal(completed.steps.length, 4);

const currentCompletedLog = completedLog.replaceAll("refresh_full", "refresh_daily");
assert.equal(parseSchedulerLog(currentCompletedLog, steps, startSteps).status, "COMPLETED");

const failedLog = [
  "[2026-10-07 09:00:01] ▶ refresh_full: python update_all_datasets.py",
  "[2026-10-07 09:00:01] ■ refresh_full exit=1",
  "[2026-10-07 09:00:01] 跳过 dataset_validate：上游步骤失败，本轮 batch 中止",
  "[2026-10-07 09:00:01] 跳过 daily_observation_sync：上游步骤失败，本轮 batch 中止",
  "[2026-10-07 09:00:01] 跳过 monitor：上游步骤失败，本轮 batch 中止",
].join("\n");

const failed = parseSchedulerLog(failedLog, steps);
assert.equal(failed.status, "FAILED");
assert.equal(failed.failedStep, "refresh_full");
assert.equal(failed.failedExitCode, 1);
assert.deepEqual(failed.skipped.map((s) => s.name), ["dataset_validate", "daily_observation_sync", "monitor"]);

const runningLog = ["[2026-10-07 09:00:01] ▶ refresh_full: python update_all_datasets.py"].join("\n");
assert.equal(parseSchedulerLog(runningLog, steps).status, "RUNNING");
const currentRunningLog = runningLog.replace("refresh_full", "refresh_daily");
assert.equal(parseSchedulerLog(currentRunningLog, steps, startSteps).status, "RUNNING");

const noDaily = ["[2026-10-07 17:00:00] ▶ refresh_order_data: python order_data_to_parquet.py"].join("\n");
assert.equal(parseSchedulerLog(noDaily, steps).status, "UNKNOWN");

const dir = await mkdtemp(join(tmpdir(), "mashang-runtime-"));
try {
  await writeFile(join(dir, "2026-10-06.log"), completedLog, "utf8");
  await writeFile(join(dir, "2026-10-07.log"), failedLog, "utf8");
  await writeFile(join(dir, "2026-10-08.log"), currentCompletedLog, "utf8");
  const latest = await readDailyJob({ logDir: dir, steps, startSteps });
  assert.equal(latest.status, "COMPLETED", "current scheduler marker should be recognized");

  await writeFile(join(dir, "2026-10-09.log"), failedLog.replaceAll("refresh_full", "refresh_daily"), "utf8");
  const latestFailed = await readDailyJob({ logDir: dir, steps, startSteps });
  assert.equal(latestFailed.status, "FAILED");
  assert.equal(latestFailed.failedStep, "refresh_daily");
  assert.equal(latestFailed.logDate, "2026-10-09");

  const missing = await readDailyJob({ logDir: join(dir, "nope"), steps });
  assert.equal(missing.status, "UNKNOWN");

  const stateDir = join(dir, "runtime");
  assert.equal(await readManualJob(stateDir, "daily"), null, "no manual run yet");
  await writeManualJob(stateDir, "daily", { status: "COMPLETED", startedAt: "2026-10-07T08:00:00.000Z", finishedAt: "2026-10-07T08:05:00.000Z", code: 0 });
  assert.equal((await readManualOperation(stateDir, "daily")).status, "COMPLETED", "operation migration should preserve a prior job run record");

  // RUNNING is persisted before completion.
  const startedAt = "2026-10-07T14:00:00.000Z";
  await writeManualJob(stateDir, "daily", { status: "RUNNING", startedAt, finishedAt: null, code: null });
  const runningManual = await readManualJob(stateDir, "daily");
  assert.equal(runningManual.status, "RUNNING");
  assert.equal(runningManual.startedAt, startedAt);
  assert.equal(runningManual.finishedAt, null);

  // Successful manual run: scheduler 09:00 FAILED is superseded by manual COMPLETED.
  const finishedAt = "2026-10-07T14:05:00.000Z";
  await writeManualJob(stateDir, "daily", { status: "COMPLETED", startedAt, finishedAt, code: 0 });
  const completedManual = await readManualJob(stateDir, "daily");
  assert.equal(completedManual.status, "COMPLETED");
  assert.equal(completedManual.code, 0);
  const scheduled = await readDailyJob({ logDir: dir, steps });
  assert.equal(scheduled.status, "FAILED");
  let chosen = pickLatestRun(scheduled, completedManual);
  assert.equal(chosen.status, "COMPLETED", "manual run should override the older scheduler failure");
  assert.equal(chosen.finishedAt, finishedAt);

  // Failed manual run: lastRun reflects the failure.
  const failedManual = { status: "FAILED", startedAt: "2026-10-08T12:00:00.000Z", finishedAt: "2026-10-08T12:01:00.000Z", code: 1 };
  chosen = pickLatestRun(scheduled, failedManual);
  assert.equal(chosen.status, "FAILED");
  assert.equal(chosen.startedAt, "2026-10-08T12:00:00.000Z");

  // A newer scheduler run naturally overrides the older manual result.
  const newerScheduler = { status: "COMPLETED", startedAt: "2026-10-09 09:00:01", finishedAt: "2026-10-09 09:05:00" };
  assert.equal(pickLatestRun(newerScheduler, completedManual), newerScheduler);
  assert.equal(pickLatestRun(newerScheduler, null), newerScheduler);
  assert.equal(pickLatestRun(null, completedManual), completedManual);

  // Worker restart: the manual result is read back from runtimeDir.
  const afterRestart = await readManualJob(stateDir, "daily");
  assert.equal(afterRestart.status, "COMPLETED");
  assert.equal(afterRestart.finishedAt, finishedAt);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("Runtime daily-job checks passed");
