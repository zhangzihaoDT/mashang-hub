import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchedulerLog, readDailyJob } from "../worker/runtime/jobs.mjs";
import { DAILY_PIPELINE_STEPS } from "../worker/runtime/registry.mjs";

const steps = [...DAILY_PIPELINE_STEPS];

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

const noDaily = ["[2026-10-07 17:00:00] ▶ refresh_order_data: python order_data_to_parquet.py"].join("\n");
assert.equal(parseSchedulerLog(noDaily, steps).status, "UNKNOWN");

const dir = await mkdtemp(join(tmpdir(), "mashang-runtime-"));
try {
  await writeFile(join(dir, "2026-10-06.log"), completedLog, "utf8");
  await writeFile(join(dir, "2026-10-07.log"), failedLog, "utf8");
  const latest = await readDailyJob({ logDir: dir, steps });
  assert.equal(latest.status, "FAILED");
  assert.equal(latest.failedStep, "refresh_full");
  assert.equal(latest.logDate, "2026-10-07");

  const missing = await readDailyJob({ logDir: join(dir, "nope"), steps });
  assert.equal(missing.status, "UNKNOWN");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("Runtime daily-job checks passed");
