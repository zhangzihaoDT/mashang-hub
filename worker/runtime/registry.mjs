import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";
const DEFAULT_FETCH_URL = "http://127.0.0.1:7860";
const DEFAULT_MIIT_URL = "http://127.0.0.1:8790";
const DEFAULT_MYKNBASE_URL = "http://127.0.0.1:4317";

export const DAILY_PIPELINE_STEPS = Object.freeze([
  "refresh_daily",
  "dataset_validate",
  "daily_observation_sync",
  "monitor",
]);
export const DAILY_PIPELINE_STARTS = Object.freeze(["refresh_daily", "refresh_full"]);

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

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
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
 * Build the local runtime registry.
 *
 * This registry is data, not business logic: it declares how to reach each
 * local runtime, how to start/stop it with its *current canonical* entry, and
 * where to discover operation status and execute declared no-argument
 * operations. Machine specifics come from the environment or an optional JSON
 * config, never from the Hub.
 *
 * `match` is the canonical process signature. `legacy` lists retired entry
 * signatures that must never be treated as a valid online service.
 */
export function buildRegistry(env = process.env, config = null) {
  const serviceRoot = env.MASHANG_SERVICE_ROOT || join(homedir(), "Documents/github/mashang-service");
  const hubRoot = env.MASHANG_HUB_ROOT || HUB_ROOT;
  const fetchRoot = env.MASHANG_FETCH_ROOT || join(homedir(), "Documents/github/mashang-fetch");
  const miitRoot = env.MASHANG_MIIT_ROOT || join(homedir(), "Documents/github/mashang-miit");
  const myknbaseRoot = env.MYKNBASE_ROOT || join(homedir(), "Documents/github/mashang-knbase");
  const aksignalRoot = env.MASHANG_AKSIGNAL_ROOT || join(homedir(), "Documents/github/AKsignal");
  const runtimeDir = env.MASHANG_RUNTIME_DIR || join(hubRoot, ".local/runtime");
  const schedulerLogDir = join(serviceRoot, "logs/scheduler");

  const opencodeURL = trimSlash(env.OPENCODE_URL || DEFAULT_OPENCODE_URL);
  const fetchURL = trimSlash(env.MASHANG_FETCH_URL || DEFAULT_FETCH_URL);
  const miitURL = trimSlash(env.MASHANG_MIIT_URL || DEFAULT_MIIT_URL);
  const myknbaseURL = trimSlash(env.MYKNBASE_URL || DEFAULT_MYKNBASE_URL);
  const miitPort = portOf(miitURL, "8790");
  const myknbasePort = portOf(myknbaseURL, "4317");
  const schedulerSeries = env.MASHANG_SCHEDULER_SERIES || "";
  const probeTimeoutMs = Number(env.RUNTIME_PROBE_TIMEOUT_MS) > 0 ? Number(env.RUNTIME_PROBE_TIMEOUT_MS) : 2500;
  const verifyMs = Number(env.RUNTIME_CONTROL_VERIFY_MS) > 0 ? Number(env.RUNTIME_CONTROL_VERIFY_MS) : 15000;
  const stopTimeoutMs = Number(env.RUNTIME_CONTROL_STOP_MS) > 0 ? Number(env.RUNTIME_CONTROL_STOP_MS) : 8000;

  const defaults = {
    probeTimeoutMs,
    verifyMs,
    runtimeDir,
    dependencies: [
      {
        id: "opencode",
        label: "OpenCode",
        category: "dependency",
        description: "Worker 本地 Agent Runtime",
        probe: { type: "http", url: `${opencodeURL}/config/providers` },
        match: "opencode serve",
        logs: [{ label: "opencode", path: join(hubRoot, ".local/logs/opencode.log") }],
      },
    ],
    services: [
      {
        id: "fetch",
        workspace: "fetch",
        label: "mashang-fetch",
        group: "APPS",
        category: "service",
        description: "外部链接 → 本地结构化文件",
        openUrl: env.MASHANG_FETCH_UI_URL || originOf(fetchURL),
        probe: { type: "http", url: `${fetchURL}/api/formats` },
        match: "uvicorn server:app",
        logs: [{ label: "app", path: join(fetchRoot, ".local/app.log") }],
        control: {
          start: { command: "./scripts/dev.sh", args: ["start"], cwd: fetchRoot, detach: false },
          stop: { command: "./scripts/dev.sh", args: ["stop"], cwd: fetchRoot },
        },
      },
      {
        id: "miit",
        workspace: "miit",
        label: "mashang-miit",
        group: "APPS",
        category: "service",
        description: "工信部公告采集、任务管理与报告工作台",
        openUrl: env.MASHANG_MIIT_UI_URL || originOf(miitURL),
        probe: { type: "http", url: `${miitURL}/` },
        match: `scripts/workbench_server\\.py --port ${miitPort}`,
        logs: [{ label: "app", path: join(miitRoot, "runs/workbench/server.log") }],
        control: {
          start: { command: "./scripts/dev.sh", args: ["start"], cwd: miitRoot, detach: false, env: { PORT: miitPort } },
          stop: { command: "./scripts/dev.sh", args: ["stop"], cwd: miitRoot, env: { PORT: miitPort } },
        },
      },
      {
        id: "myknbase",
        workspace: "knbase",
        label: "mashang-knbase",
        group: "APPS",
        category: "service",
        description: "个人本地知识库",
        openUrl: env.MYKNBASE_UI_URL || originOf(myknbaseURL),
        probe: { type: "http", url: `${myknbaseURL}/api/tree` },
        match: "node(?: .*?)? server/main\\.mjs$",
        logs: [],
        control: {
          start: { command: "npm", args: ["start"], cwd: myknbaseRoot, detach: true, env: { PORT: String(myknbasePort) } },
          stop: { signal: "SIGTERM", timeoutMs: stopTimeoutMs },
        },
      },
      {
        id: "scheduler",
        workspace: "service",
        label: "Scheduler",
        group: "MASHANG-SERVICE",
        summary: "后台服务",
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
      {
        id: "aksignal-scheduler",
        workspace: "aksignal",
        presentation: "schedule-control",
        label: "AKsignal Scheduler",
        group: "AKSIGNAL",
        summary: "独立 08:30 调度；错过或失败后等待面板手动运行",
        category: "runtime",
        description: "由 AKsignal LaunchAgent 管理，不依赖 Service Scheduler；重启调度器不会重跑 Daily 批次。",
        probe: { type: "process", match: "src.daily_scheduler --daemon" },
        match: "src.daily_scheduler --daemon",
        logs: [{ label: "scheduler", path: join(aksignalRoot, ".run_day/scheduler/agent.log") }],
        control: {
          start: { command: join(aksignalRoot, ".venv/bin/python"),
            args: ["-m", "src.daily_scheduler", "install"], cwd: aksignalRoot },
          stop: { command: join(aksignalRoot, ".venv/bin/python"),
            args: ["-m", "src.daily_scheduler", "stop"], cwd: aksignalRoot },
        },
      },
    ],
    jobs: [],
    operations: [
      {
        id: "aksignal-daily", workspace: "aksignal", label: "AKsignal Daily", group: "AKSIGNAL",
        description: "手动运行 / 恢复：先联网更新数据；兼容检查点继续运行，不兼容时自动创建新批次。已发布日期不重复运行。请求受理不等于日报已发布。",
        enabled: true, cancellationSupported: false, requestOnly: true, timeoutMs: 60000,
        probe: { type: "command-json", command: join(aksignalRoot, ".venv/bin/python"),
          args: ["-m", "src.daily_hub"], cwd: aksignalRoot,
          artifactRoot: join(aksignalRoot, ".run_day/runs") },
        run: { command: join(aksignalRoot, ".venv/bin/python"),
          args: ["-m", "src.daily_schedule", "--manual-run"], cwd: aksignalRoot },
      },
      {
        id: "aksignal-comparison-update", workspace: "aksignal", presentation: "inline-action",
        label: "更新 Compare", group: "AKSIGNAL",
        description: "手动刷新独立篮子研究快照；失败时保留最近一次有效结果。",
        enabled: true, cancellationSupported: false, timeoutMs: 900000,
        run: { command: join(aksignalRoot, ".venv/bin/python"),
          args: ["-m", "src.research.baskets.hub_update"], cwd: aksignalRoot },
      },
      ...(env.MASHANG_CONTENT_ENABLED === '1' ? [{ id: 'notes-flomo', workspace: 'publish', label: '同步 Flomo', enabled: true, requiresSnapshot: true, cancellationSupported: false, timeoutMs: 60000 }] : []),
      ...((env.MASHANG_PUBLISH_SERVICE_URL || env.MASHANG_PUBLISH_DIRECT === '1') ? [{ id: 'text-publication', workspace: 'publish', label: '微博文本发布', description: '审阅不可变正文后明确授权；结果不确定时只核验。', enabled: true, requiresSnapshot: true, cancellationSupported: false, timeoutMs: 60000 }] : []),
      {
        id: "daily",
        workspace: "service",
        label: "Daily pipeline",
        group: "MASHANG-SERVICE",
        description: "刷新、校验与观察同步；会写入本地数据并同步外部系统（不含销售监控）。",
        enabled: true,
        cancellationSupported: true,
        timeoutMs: 1800000,
        probe: { type: "scheduler-log", logDir: schedulerLogDir, steps: [...DAILY_PIPELINE_STEPS], startSteps: [...DAILY_PIPELINE_STARTS] },
        logs: [{ label: "daily (latest)", dir: schedulerLogDir, pattern: DATED_LOG_PATTERN }],
        run: {
          command: "make",
          args: ["data-pipeline"],
          cwd: serviceRoot,
          detach: false,
          env: schedulerSeries ? { SERIES: schedulerSeries } : {},
        },
      },
      {
        id: "allupdate",
        workspace: "service",
        label: "Full data update",
        group: "MASHANG-SERVICE",
        description: "刷新全部数据集并校验；会写入本地数据。",
        enabled: true,
        cancellationSupported: true,
        timeoutMs: 1800000,
        run: {
          command: "make",
          args: ["allupdate"],
          cwd: serviceRoot,
          detach: false,
          env: schedulerSeries ? { SERIES: schedulerSeries } : {},
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
    dependencies: mergeById(defaults.dependencies, config.dependencies),
    services: mergeById(defaults.services, config.services),
    jobs: mergeById(defaults.jobs, config.jobs),
    operations: mergeById(defaults.operations, config.operations),
  };
}
