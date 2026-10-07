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

function trimSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function mergeById(defaults, overrides) {
  const merged = new Map(defaults.map((entry) => [entry.id, entry]));
  for (const entry of overrides || []) {
    if (!entry || !entry.id) continue;
    const base = merged.get(entry.id) || {};
    merged.set(entry.id, { ...base, ...entry, probe: { ...(base.probe || {}), ...(entry.probe || {}) } });
  }
  return [...merged.values()];
}

/**
 * Build the local services/jobs registry.
 *
 * This registry is data, not business logic: it declares how to reach each
 * local runtime and where to read the last daily-job result. Machine specifics
 * come from the environment or an optional JSON config, never from the Hub.
 */
export function buildRegistry(env = process.env, config = null) {
  const serviceRoot = env.MASHANG_SERVICE_ROOT || join(homedir(), "Documents/github/mashang-service");
  const hubRoot = env.MASHANG_HUB_ROOT || HUB_ROOT;
  const opencodeURL = trimSlash(env.OPENCODE_URL || DEFAULT_OPENCODE_URL);
  const fetchURL = trimSlash(env.MASHANG_FETCH_URL || DEFAULT_FETCH_URL);
  const myknbaseURL = trimSlash(env.MYKNBASE_URL || DEFAULT_MYKNBASE_URL);
  const probeTimeoutMs = Number(env.RUNTIME_PROBE_TIMEOUT_MS) > 0 ? Number(env.RUNTIME_PROBE_TIMEOUT_MS) : 2500;

  const defaults = {
    probeTimeoutMs,
    services: [
      {
        id: "fetch",
        label: "mashang-fetch",
        category: "service",
        description: "外部链接 → 本地结构化文件",
        probe: { type: "http", url: `${fetchURL}/api/formats` },
      },
      {
        id: "myknbase",
        label: "myknbase",
        category: "service",
        description: "个人本地知识库",
        probe: { type: "http", url: `${myknbaseURL}/api/health` },
      },
      {
        id: "opencode",
        label: "OpenCode",
        category: "runtime",
        description: "本地 Agent Runtime",
        probe: { type: "http", url: `${opencodeURL}/config/providers` },
      },
      {
        id: "worker",
        label: "Mac Worker",
        category: "runtime",
        description: "mashang-hub 本地执行端",
        probe: { type: "process", match: "worker/worker.mjs", pidFile: join(hubRoot, ".local/pids/worker.pid") },
      },
      {
        id: "scheduler",
        label: "mashang-service scheduler",
        category: "runtime",
        description: "常驻调度器（刷新 + 监控）",
        probe: { type: "process", match: "sales_scheduler.py" },
      },
    ],
    jobs: [
      {
        id: "daily",
        label: "mashang-service daily pipeline",
        description: "每日 09:00 刷新 → 校验 → 同步 → 监控",
        probe: { type: "scheduler-log", logDir: join(serviceRoot, "logs/scheduler"), steps: [...DAILY_PIPELINE_STEPS] },
      },
    ],
  };

  if (!config) return defaults;
  return {
    ...defaults,
    ...config,
    probeTimeoutMs: config.probeTimeoutMs || defaults.probeTimeoutMs,
    services: mergeById(defaults.services, config.services),
    jobs: mergeById(defaults.jobs, config.jobs),
  };
}
