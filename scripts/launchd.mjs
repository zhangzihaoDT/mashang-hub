#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCHD_SERVICES = Object.freeze([
  { key: "opencode", label: "com.mashang-hub.opencode", plist: "com.mashang-hub.opencode.plist", log: "opencode.log", errorLog: "opencode.error.log" },
  { key: "worker", label: "com.mashang-hub.worker", plist: "com.mashang-hub.worker.plist", log: "worker.log", errorLog: "worker.error.log" },
]);

function xml(value) {
  const text = String(value);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new Error("launchd configuration contains an invalid XML control character");
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function stringElement(value) { return `<string>${xml(value)}</string>`; }

function renderDictionary(values, indent = "    ") {
  return ["<dict>", ...Object.entries(values).flatMap(([key, value]) => {
    const lines = [`${indent}<key>${xml(key)}</key>`];
    if (typeof value === "boolean") lines.push(`${indent}<${value ? "true" : "false"}/>`);
    else if (Array.isArray(value)) lines.push(`${indent}<array>${value.map(stringElement).join("")}</array>`);
    else if (value && typeof value === "object") lines.push(`${indent}${renderDictionary(value, `${indent}  `)}`);
    else lines.push(`${indent}${stringElement(value)}`);
    return lines;
  }), "  </dict>"].join("\n");
}

export function renderPlist(job) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderDictionary(job.plist),
    "</plist>",
    "",
  ].join("\n");
}

function expandHome(path, home) {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function localOnlyHost(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase());
}

function workerHubURL(value) {
  if (!value) throw new Error("HUB_URL is required; use the HTTPS URL of the Sealos Hub");
  let url;
  try { url = new URL(value); } catch { throw new Error("HUB_URL must be a valid http:// or https:// URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("HUB_URL must be a base http:// or https:// URL without credentials, path, query or fragment");
  }
  if (url.protocol === "http:" && !localOnlyHost(url.hostname)) throw new Error("Use HTTPS for a non-local HUB_URL");
  return url.origin;
}

function opencodeConfig(env) {
  let configured;
  try { configured = new URL(env.OPENCODE_URL || "http://127.0.0.1:4096"); } catch { throw new Error("OPENCODE_URL must be a valid local HTTP URL"); }
  if (configured.protocol !== "http:" || !localOnlyHost(configured.hostname) || configured.username || configured.password) {
    throw new Error("OpenCode must remain bound to localhost or a loopback address");
  }
  const host = (env.OPENCODE_HOST || configured.hostname).replace(/^\[|\]$/g, "");
  if (!localOnlyHost(host)) throw new Error("OPENCODE_HOST must be a loopback address");
  const rawPort = env.OPENCODE_PORT || configured.port || "4096";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPENCODE_PORT must be between 1 and 65535");
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return { host, port: String(port), url: `${configured.protocol}//${urlHost}:${port}` };
}

function executable(name, pathValue) {
  if (name.includes("/")) {
    const candidate = resolve(name);
    try { accessSync(candidate, constants.X_OK); } catch { throw new Error(`OPENCODE_BIN is not executable: ${candidate}`); }
    return candidate;
  }
  const pathEntries = String(pathValue || "").split(":").filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Continue searching PATH. */ }
  }
  throw new Error(`Could not find '${name}' on PATH; set OPENCODE_BIN to its absolute path`);
}

export function buildLaunchdAgents({ root = ROOT, home = homedir(), env = process.env, nodePath = process.execPath, opencodePath } = {}) {
  const hubURL = workerHubURL(env.HUB_URL);
  if (!env.WORKER_SECRET) throw new Error("WORKER_SECRET is required");
  const serviceRoot = resolve(expandHome(env.MASHANG_SERVICE_ROOT || join(home, "Documents/github/mashang-service"), home));
  const opencode = opencodeConfig(env);
  const pathValue = env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const opencodeExecutable = opencodePath || executable(env.OPENCODE_BIN || "opencode", pathValue);
  const launchAgentsDir = join(home, "Library/LaunchAgents");
  const logDir = join(home, "Library/Logs/mashang-hub");
  const common = {
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
  };
  const passthrough = [
    "WORKER_ID",
    "WORKER_STATE_FILE",
    "WORKER_EXECUTION_JOURNAL",
    "MASHANG_WORKSPACES_CONFIG",
    "MASHANG_PUBLISH_ENABLED",
    "MASHANG_PUBLISH_ROOT",
    "MASHANG_PUBLISH_GATE_DIR",
    "MASHANG_RUNTIME_CONFIG",
    "MASHANG_FETCH_ROOT",
    "MYKNBASE_ROOT",
    "MASHANG_FETCH_URL",
    "MYKNBASE_URL",
    "MASHANG_RUNTIME_DIR",
    "MASHANG_SCHEDULER_SERIES",
    "RUNTIME_PROBE_TIMEOUT_MS",
    "RUNTIME_SNAPSHOT_INTERVAL_MS",
    "WORKER_HEARTBEAT_MS",
    "TASK_TIMEOUT_MS",
    "TASK_CANCEL_GRACE_MS",
  ];
  const workerEnvironment = {
    HOME: home,
    PATH: pathValue,
    HUB_URL: hubURL,
    WORKER_SECRET: env.WORKER_SECRET,
    MASHANG_SERVICE_ROOT: serviceRoot,
    OPENCODE_URL: opencode.url,
  };
  for (const key of passthrough) if (env[key] !== undefined && env[key] !== "") workerEnvironment[key] = env[key];

  return [
    {
      ...LAUNCHD_SERVICES[0],
      plist: {
        Label: LAUNCHD_SERVICES[0].label,
        ProgramArguments: [opencodeExecutable, "serve", "--hostname", opencode.host, "--port", opencode.port],
        WorkingDirectory: serviceRoot,
        EnvironmentVariables: { HOME: home, PATH: pathValue },
        StandardOutPath: join(logDir, LAUNCHD_SERVICES[0].log),
        StandardErrorPath: join(logDir, LAUNCHD_SERVICES[0].errorLog),
        ...common,
      },
      plistPath: join(launchAgentsDir, LAUNCHD_SERVICES[0].plist),
    },
    {
      ...LAUNCHD_SERVICES[1],
      plist: {
        Label: LAUNCHD_SERVICES[1].label,
        ProgramArguments: [nodePath, resolve(root, "worker/worker.mjs")],
        WorkingDirectory: resolve(root),
        EnvironmentVariables: workerEnvironment,
        StandardOutPath: join(logDir, LAUNCHD_SERVICES[1].log),
        StandardErrorPath: join(logDir, LAUNCHD_SERVICES[1].errorLog),
        ...common,
      },
      plistPath: join(launchAgentsDir, LAUNCHD_SERVICES[1].plist),
    },
  ];
}

function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync(process.env.LAUNCHCTL_BIN || "/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "ignore" : "pipe"] });
  } catch (error) {
    if (quiet) return null;
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`launchctl ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function guiDomain(uid = process.getuid?.()) {
  if (!Number.isInteger(uid)) throw new Error("Could not determine the current macOS user id");
  return `gui/${uid}`;
}

function requireMacOS(platform = process.platform) {
  if (platform !== "darwin") throw new Error("launchd management is available only on macOS");
}

async function isPortListening(host, port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: host.replace(/^\[|\]$/g, ""), port: Number(port) });
    const finish = (result) => { socket.destroy(); resolvePromise(result); };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function runningWorkerPid(root) {
  try {
    const output = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    const workerPath = resolve(root, "worker/worker.mjs");
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && Number(match[1]) !== process.pid && match[2].includes(workerPath)) return Number(match[1]);
    }
  } catch { /* The port and launchctl checks still provide useful protection. */ }
  return null;
}

async function validateInstall(root, home, env) {
  const serviceRoot = resolve(expandHome(env.MASHANG_SERVICE_ROOT || join(home, "Documents/github/mashang-service"), home));
  try {
    if (!(await stat(serviceRoot)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`MASHANG_SERVICE_ROOT is not a directory: ${serviceRoot}`);
  }
  return buildLaunchdAgents({ root, home, env });
}

async function assertNoConflictingProcesses(root, env) {
  const openCode = opencodeConfig(env);
  if (await isPortListening(openCode.host, openCode.port)) {
    throw new Error(`OpenCode port ${openCode.port} is already in use. Stop the existing process (for development mode, run npm run down) before installing launchd.`);
  }
  const pid = runningWorkerPid(root);
  if (pid) throw new Error(`A Worker process is already running (pid ${pid}). Stop it before installing launchd.`);
}

export async function installLaunchAgents({ root = ROOT, home = homedir(), env = process.env, uid = process.getuid?.(), platform = process.platform } = {}) {
  requireMacOS(platform);
  const domain = guiDomain(uid);
  const agents = await validateInstall(root, home, env);
  const launchAgentsDir = join(home, "Library/LaunchAgents");
  const logDir = join(home, "Library/Logs/mashang-hub");
  await mkdir(launchAgentsDir, { recursive: true });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await chmod(logDir, 0o700);

  for (const agent of [...agents].reverse()) launchctl(["bootout", domain, agent.plistPath], { quiet: true });
  await assertNoConflictingProcesses(root, env);
  for (const agent of agents) {
    const temporaryPath = `${agent.plistPath}.tmp`;
    await writeFile(temporaryPath, renderPlist(agent), { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, agent.plistPath);
  }

  const bootstrapped = [];
  try {
    for (const agent of agents) {
      launchctl(["bootstrap", domain, agent.plistPath]);
      bootstrapped.push(agent);
    }
  } catch (error) {
    for (const agent of bootstrapped.reverse()) launchctl(["bootout", domain, agent.plistPath], { quiet: true });
    throw error;
  }
  return agents;
}

export async function uninstallLaunchAgents({ home = homedir(), uid = process.getuid?.(), platform = process.platform } = {}) {
  requireMacOS(platform);
  const domain = guiDomain(uid);
  const directory = join(home, "Library/LaunchAgents");
  for (const service of [...LAUNCHD_SERVICES].reverse()) {
    const plistPath = join(directory, service.plist);
    launchctl(["bootout", domain, plistPath], { quiet: true });
    await rm(plistPath, { force: true });
  }
}

export function restartLaunchAgents({ uid = process.getuid?.(), platform = process.platform } = {}) {
  requireMacOS(platform);
  const domain = guiDomain(uid);
  for (const service of LAUNCHD_SERVICES) launchctl(["kickstart", "-k", `${domain}/${service.label}`]);
}

export function statusLaunchAgents({ home = homedir(), uid = process.getuid?.(), platform = process.platform, output = console.log } = {}) {
  requireMacOS(platform);
  const domain = guiDomain(uid);
  const directory = join(home, "Library/LaunchAgents");
  for (const service of LAUNCHD_SERVICES) {
    const plistPath = join(directory, service.plist);
    try {
      accessSync(plistPath);
    } catch {
      output(`${service.key}: not installed`);
      continue;
    }
    const details = launchctl(["print", `${domain}/${service.label}`], { quiet: true });
    if (!details) {
      output(`${service.key}: installed but not loaded`);
      continue;
    }
    const state = details.match(/^\s*state = ([^\r\n]+)/m)?.[1] || "loaded";
    const pid = details.match(/^\s*pid = (\d+)/m)?.[1];
    const lastExit = details.match(/^\s*last exit code = (-?\d+)/m)?.[1];
    output(`${service.key}: ${state}${pid ? ` (pid ${pid})` : ""}${lastExit ? ` · last exit ${lastExit}` : ""}`);
  }
}

export function tailLaunchdLogs({ home = homedir() } = {}) {
  const files = LAUNCHD_SERVICES.flatMap((service) => [service.log, service.errorLog].map((file) => join(home, "Library/Logs/mashang-hub", file)));
  const child = spawn("tail", ["-n", "40", "-f", ...files], { stdio: "inherit" });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
}

async function main(command) {
  switch (command) {
    case "install": {
      const agents = await installLaunchAgents();
      console.log(`Installed ${agents.map((agent) => agent.key).join(" and ")} as user LaunchAgents.`);
      console.log("The Hub is not started locally; the Worker connects to HUB_URL.");
      break;
    }
    case "uninstall":
      await uninstallLaunchAgents();
      console.log("Removed the mashang-hub OpenCode and Worker LaunchAgents.");
      break;
    case "status":
      statusLaunchAgents();
      break;
    case "restart":
      restartLaunchAgents();
      break;
    case "logs":
      tailLaunchdLogs();
      break;
    default:
      throw new Error("Usage: node scripts/launchd.mjs {install|uninstall|status|restart|logs}");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
