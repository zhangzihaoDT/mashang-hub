import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";
const DEFAULT_FETCH_URL = "http://127.0.0.1:7860";
const DEFAULT_MYKNBASE_URL = "http://127.0.0.1:7870";

export const DAILY_PIPELINE_STEPS = Object.freeze([
  "refresh_full",
  "dataset_validate",
  "daily_observation_sync",
  "monitor",
]);

export const DATED_LOG_PATTERN = "^\\d{4}-\\d{2}-\\d{2}\\.log$";

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function portOf(url, fallback) {
  try {
    return new URL(url).port || fallback;
  } catch {
    return fallback;
  }
}

function mergeCommand(base, override) {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return { ...base, ...override };
}

function mergeById(defaults, overrides) {
  const merged = new Map(defaults.map((entry) => [entry.id, entry]));
  for (const entry of overrides || []) {
    if (!entry || !entry.id) continue;
    const base = merged.get(entry.id) || {};
    const baseControl = base.control || {};
    const entryControl = entry.control || {};
    merged.set(entry.id, {
      ...base,
      ...entry,
      probe: { ...(base.probe || {}), ...(entry.probe || {}) },
      control: {
        ...baseControl,
        ...entryControl,
        start: mergeCommand(baseControl.start, entryControl.start),
        stop: mergeCommand(baseControl.stop, entryControl.stop),
        run: mergeCommand(baseControl.run, entryControl.run),
      },
    });
  }
  return [...merged.values()];
}

/**
 * Build the local services/jobs registry.
 *
 * This registry is data, not business logic: it declares how to reach each
 * local runtime, how to start/stop it with its *current canonical* entry, and
 * where to read the last daily-job result. Machine specifics come from the
 * environment or an optional JSON config, never from the Hub.
 *
 * `match` is the canonical process signature. `legacy` lists retired entry
 * signatures that must never be treated as a valid online service.
 */
export function buildRegistry(env = process.env, config = null) {
  const serviceRoot = env.MASHANG_SERVICE_ROOT || join(homedir(), "Documents/github/mashang-service");
  const hubRoot = env.MASHANG_HUB_ROOT || HUB_ROOT;
  const fetchRoot = env.MASHANG_FETCH_ROOT || join(homedir(), "Documents/github/mashang-fetch");
  const myknbaseRoot = env.MYKNBASE_ROOT || join(homedir(), "Desktop/myknbase");
  const runtimeDir = env.MASHANG_RUNTIME_DIR || join(hubRoot, ".local/runtime");
  const schedulerLogDir = join(serviceRoot, "logs/scheduler");

  const opencodeURL = trimSlash(env.OPENCODE_URL || DEFAULT_OPENCODE_URL);
  const opencodePort = portOf(opencodeURL, "4096");
  const fetchURL = trimSlash(env.MASHANG_FETCH_URL || DEFAULT_FETCH_URL);
  const myknbaseURL = trimSlash(env.MYKNBASE_URL || DEFAULT_MYKNBASE_URL);
  const myknbasePort = portOf(myknbaseURL, "7870");
  const schedulerSeries = env.MASHANG_SCHEDULER_SERIES || "";
  const probeTimeoutMs = Number(env.RUNTIME_PROBE_TIMEOUT_MS) > 0 ? Number(env.RUNTIME_PROBE_TIMEOUT_MS) : 2500;
  const verifyMs = Number(env.RUNTIME_CONTROL_VERIFY_MS) > 0 ? Number(env.RUNTIME_CONTROL_VERIFY_MS) : 15000;
  const stopTimeoutMs = Number(env.RUNTIME_CONTROL_STOP_MS) > 0 ? Number(env.RUNTIME_CONTROL_STOP_MS) : 8000;

  const defaults = {
    probeTimeoutMs,
    verifyMs,
    runtimeDir,
    services: [
      {
        id: "fetch",
        label: "mashang-fetch",
        category: "service",
        description: "外部链接 → 本地结构化文件",
        probe: { type: "http", url: `${fetchURL}/api/formats` },
        match: "uvicorn server:app",
        logs: [{ label: "app", path: join(fetchRoot, ".local/app.log") }],
        control: {
          start: { command: "./scripts/dev.sh", args: ["start"], cwd: fetchRoot, detach: false },
          stop: { command: "./scripts/dev.sh", args: ["stop"], cwd: fetchRoot },
        },
      },
      {
        id: "myknbase",
        label: "myknbase",
        category: "service",
        description: "个人本地知识库",
        probe: { type: "http", url: `${myknbaseURL}/api/health` },
        match: "server/index.js",
        logs: [],
        control: {
          start: { command: "npm", args: ["run", "up"], cwd: myknbaseRoot, detach: true, env: { MYKNBASE_PORT: String(myknbasePort) } },
          stop: { signal: "SIGTERM", timeoutMs: stopTimeoutMs },
        },
      },
      {
        id: "opencode",
        label: "OpenCode",
        category: "runtime",
        description: "本地 Agent Runtime",
        probe: { type: "http", url: `${opencodeURL}/config/providers` },
        match: "opencode serve",
        logs: [{ label: "opencode", path: join(hubRoot, ".local/logs/opencode.log") }],
        control: {
          start: { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", opencodePort], cwd: serviceRoot, detach: true },
          stop: { signal: "SIGTERM", timeoutMs: stopTimeoutMs },
        },
      },
      {
        id: "worker",
        label: "Mac Worker",
        category: "runtime",
        description: "mashang-hub 本地执行端",
        probe: { type: "process", match: "worker/worker.mjs", pidFile: join(hubRoot, ".local/pids/worker.pid") },
        match: "worker/worker.mjs",
        logs: [{ label: "worker", path: join(hubRoot, ".local/logs/worker.log") }],
        control: {
          start: {
            command: "node",
            args: ["worker/worker.mjs"],
            cwd: hubRoot,
            detach: true,
            env: {
              HUB_URL: env.HUB_URL || "ws://127.0.0.1:3000",
              WORKER_SECRET: env.WORKER_SECRET || "local-worker-secret",
              MASHANG_SERVICE_ROOT: serviceRoot,
              OPENCODE_URL: opencodeURL,
            },
          },
          stop: { signal: "SIGTERM", timeoutMs: stopTimeoutMs },
        },
      },
      {
        id: "scheduler",
        label: "mashang-service scheduler",
        category: "runtime",
        description: "常驻调度器（刷新 + 监控）",
        probe: { type: "process", match: "utility_scripts/sales_scheduler.py" },
        match: "utility_scripts/sales_scheduler.py",
        legacy: ["schedule_launch_lock_evening_updates"],
        logs: [{ label: "stdout", path: join(schedulerLogDir, "stdout.log") }],
        control: {
          start: {
            command: "caffeinate",
            args: ["-i", "make", "sales-scheduler"],
            cwd: serviceRoot,
            detach: true,
            env: schedulerSeries ? { SERIES: schedulerSeries } : {},
          },
          stop: { signal: "SIGTERM", timeoutMs: stopTimeoutMs },
        },
      },
    ],
    jobs: [
      {
        id: "daily",
        label: "mashang-service daily pipeline",
        description: "每日 09:00 刷新 → 校验 → 同步 → 监控",
        probe: { type: "scheduler-log", logDir: schedulerLogDir, steps: [...DAILY_PIPELINE_STEPS] },
        logs: [{ label: "daily (latest)", dir: schedulerLogDir, pattern: DATED_LOG_PATTERN }],
        control: {
          run: {
            command: "make",
            args: ["daily-ops"],
            cwd: serviceRoot,
            detach: false,
            env: schedulerSeries ? { SERIES: schedulerSeries } : {},
          },
        },
      },
    ],
  };

  if (!config) return defaults;
  return {
    ...defaults,
    ...config,
    probeTimeoutMs: config.probeTimeoutMs || defaults.probeTimeoutMs,
    verifyMs: config.verifyMs || defaults.verifyMs,
    runtimeDir: config.runtimeDir || defaults.runtimeDir,
    services: mergeById(defaults.services, config.services),
    jobs: mergeById(defaults.jobs, config.jobs),
  };
}
