#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildRegistry } from "./runtime/registry.mjs";
import { collectStatus } from "./runtime/status.mjs";
import { renderText } from "./runtime/render.mjs";
import { listLogSources, readTail, followFile } from "./runtime/logs.mjs";
import { up, down, restart, run, findService, findJob } from "./runtime/control.mjs";

const USAGE = `mashang — local runtime manager

Usage:
  mashang status [--json] [--strict]
  mashang up <service>
  mashang down <service>
  mashang restart <service>
  mashang run <job>
  mashang logs [id] [--lines N] [--follow] [--all] [--json]
  mashang help

  Services and jobs are declared by the registry; the manager only executes
  the declared canonical entry and verifies the result.

Environment:
  MASHANG_SERVICE_ROOT   mashang-service checkout (scheduler logs)
  MASHANG_HUB_ROOT       mashang-hub checkout (worker pid file, hub logs)
  MASHANG_FETCH_ROOT     mashang-fetch checkout (app log, dev.sh)
  MYKNBASE_ROOT          myknbase checkout
  MASHANG_RUNTIME_DIR    managed records + start logs (default <hub>/.local/runtime)
  MASHANG_SCHEDULER_SERIES  optional SERIES passed to the scheduler/daily job
  OPENCODE_URL           default http://127.0.0.1:4096
  MASHANG_FETCH_URL      default http://127.0.0.1:7860
  MYKNBASE_URL           default http://127.0.0.1:7870
  HUB_URL                worker registration target (default ws://127.0.0.1:3000)
  MASHANG_RUNTIME_CONFIG path to a JSON {services,jobs} override
  RUNTIME_PROBE_TIMEOUT_MS  per-probe timeout, default 2500
  RUNTIME_CONTROL_VERIFY_MS post-action verification window, default 15000
`;

function parseArgs(args) {
  const options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--lines") { options.lines = Number(args[++i]); continue; }
    if (arg.startsWith("--lines=")) { options.lines = Number(arg.slice("--lines=".length)); continue; }
    if (arg.startsWith("-")) { options[arg] = true; continue; }
    options._.push(arg);
  }
  return options;
}

function formatBytes(bytes) {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadConfig(env) {
  const path = env.MASHANG_RUNTIME_CONFIG;
  if (!path) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    console.error(`warning: could not read MASHANG_RUNTIME_CONFIG (${path}): ${error.message}`);
    return null;
  }
}

async function commandStatus(rawArgs, env) {
  const args = parseArgs(rawArgs);
  const registry = buildRegistry(env, await loadConfig(env));
  const status = await collectStatus(registry);

  process.stdout.write(args["--json"] ? `${JSON.stringify(status, null, 2)}\n` : renderText(status));

  if (args["--strict"]) {
    const serviceDown = status.services.some((service) => !service.online);
    const jobFailed = status.jobs.some((job) => job.status === "FAILED");
    if (serviceDown || jobFailed) process.exitCode = 1;
  }
}

const CONTROL_LOGGER = { log: (message) => console.log(message), warn: (message) => console.warn(message) };

function describeControl(kind, id, result) {
  if (kind === "restart") {
    const downPart = describeControl("down", id, result.down);
    const upPart = result.up ? describeControl("up", id, result.up) : "";
    return `${downPart}${upPart}`;
  }
  const messages = {
    "already-running": `service ${id} already running (${result.managed ? "managed" : "unmanaged"})`,
    started: `service ${id} is online`,
    unverified: `service ${id} action did not reach the expected state`,
    "start-failed": `service ${id} failed to start (exit ${result.code})`,
    "already-stopped": `service ${id} already stopped`,
    stopped: `service ${id} is offline`,
    "stop-failed": `service ${id} failed to stop (exit ${result.code})`,
    refused: `service ${id} refused: ${result.reason}`,
  };
  return `${messages[result.status] || `service ${id} ${result.status}`}\n`;
}

async function commandControl(kind, rawArgs, env) {
  const args = parseArgs(rawArgs);
  const id = args._[0];
  if (!id) {
    process.stderr.write(`usage: mashang ${kind} <${kind === "run" ? "job" : "service"}>\n`);
    process.exitCode = 2;
    return;
  }
  const registry = buildRegistry(env, await loadConfig(env));

  if (kind === "run") {
    const job = findJob(registry, id);
    if (!job) {
      process.stderr.write(`unknown job: ${id}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      const result = await run(job, registry, { log: CONTROL_LOGGER });
      process.stdout.write(`job ${id} ${result.status} (exit ${result.code})\n`);
      process.exitCode = result.status === "completed" ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  const service = findService(registry, id);
  if (!service) {
    process.stderr.write(`unknown service: ${id}\navailable: ${registry.services.map((s) => s.id).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const result = kind === "up"
      ? await up(service, registry, { log: CONTROL_LOGGER })
      : kind === "down"
        ? await down(service, registry, { log: CONTROL_LOGGER })
        : await restart(service, registry, { log: CONTROL_LOGGER });
    process.stdout.write(describeControl(kind, id, result));
    process.exitCode = ["started", "already-running", "stopped", "already-stopped"].includes(result.status) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

function renderLogList(sources) {
  if (!sources.length) return "no log sources registered\n";
  const lines = ["LOG SOURCES"];
  for (const source of sources) {
    const dot = source.exists ? "\u001b[32m●\u001b[0m" : "\u001b[31m○\u001b[0m";
    const where = source.path || "(not found)";
    const size = source.exists ? formatBytes(source.size) : "-";
    const seen = source.mtime ? `  ${source.mtime}` : "";
    lines.push(`  ${dot} ${source.id.padEnd(12)} ${source.label.padEnd(16)} ${size.padStart(9)}  ${where}${seen}`);
  }
  return `${lines.join("\n")}\n`;
}

async function commandLogs(rawArgs, env) {
  const args = parseArgs(rawArgs);
  const registry = buildRegistry(env, await loadConfig(env));
  const sources = await listLogSources(registry);
  const lines = Number.isInteger(args.lines) && args.lines > 0 ? args.lines : 40;
  const id = args._[0] || null;

  const selected = args["--all"] ? sources : id ? sources.filter((source) => source.id === id) : [];

  if (!selected.length && !args["--json"] && !id && !args["--all"]) {
    process.stdout.write(renderLogList(sources));
    return;
  }
  if (id && !selected.length) {
    process.stderr.write(`unknown log id: ${id}\navailable: ${[...new Set(sources.map((s) => s.id))].join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  if (args["--json"] && !id && !args["--all"]) {
    process.stdout.write(`${JSON.stringify(sources, null, 2)}\n`);
    return;
  }

  const existing = selected.filter((source) => source.exists && source.path);
  for (const source of selected) {
    if (!source.exists) console.error(`(${source.id}/${source.label}) not found: ${source.path || "(no path)"}`);
  }
  if (!existing.length) {
    process.exitCode = 1;
    return;
  }

  if (args["--follow"] && existing.length > 1) {
    process.stderr.write("--follow requires a single log source; pass an id\n");
    process.exitCode = 2;
    return;
  }

  const multiple = existing.length > 1;
  for (const source of existing) {
    if (multiple) process.stdout.write(`\u001b[2m== ${source.id}/${source.label} · ${source.path} ==\u001b[0m\n`);
    const tail = await readTail(source.path, lines);
    if (tail) process.stdout.write(`${tail}\n`);
  }

  if (!args["--follow"]) return;

  const source = existing[0];
  process.stdout.write(`\u001b[2m-- following ${source.path} (Ctrl-C to stop) --\u001b[0m\n`);
  await new Promise((resolve) => {
    const stop = followFile(source.path, (chunk) => process.stdout.write(chunk));
    process.on("SIGINT", () => { stop(); resolve(); });
  });
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "status") return commandStatus(args, process.env);
  if (command === "up" || command === "down" || command === "restart" || command === "run") return commandControl(command, args, process.env);
  if (command === "logs") return commandLogs(args, process.env);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

await main();
