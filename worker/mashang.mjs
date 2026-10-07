#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { buildRegistry } from "./runtime/registry.mjs";
import { collectStatus } from "./runtime/status.mjs";
import { renderText } from "./runtime/render.mjs";

const USAGE = `mashang — local runtime manager (read-only)

Usage:
  mashang status [--json] [--strict]
  mashang help

Environment:
  MASHANG_SERVICE_ROOT   mashang-service checkout (scheduler logs)
  MASHANG_HUB_ROOT       mashang-hub checkout (worker pid file)
  OPENCODE_URL           default http://127.0.0.1:4096
  MASHANG_FETCH_URL      default http://127.0.0.1:7860
  MYKNBASE_URL           default http://127.0.0.1:7870
  MASHANG_RUNTIME_CONFIG path to a JSON {services,jobs} override
  RUNTIME_PROBE_TIMEOUT_MS  per-probe timeout, default 2500

V0.1 is read-only: it reports state and never starts or stops anything.
`;

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

async function commandStatus(args, env) {
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  const registry = buildRegistry(env, await loadConfig(env));
  const status = await collectStatus(registry);

  process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : renderText(status));

  if (strict) {
    const serviceDown = status.services.some((service) => !service.online);
    const jobFailed = status.jobs.some((job) => job.status === "FAILED");
    if (serviceDown || jobFailed) process.exitCode = 1;
  }
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "status") return commandStatus(args, process.env);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

await main();
