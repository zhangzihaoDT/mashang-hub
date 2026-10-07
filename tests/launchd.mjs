import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunchdAgents, LAUNCHD_SERVICES, renderPlist } from "../scripts/launchd.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const root = "/workspace/mashang-hub";
const home = "/Users/test-user";
const env = {
  HUB_URL: "https://mashang-hub.example.com",
  WORKER_SECRET: "secret<&",
  MASHANG_SERVICE_ROOT: "~/Documents/github/mashang-service",
  OPENCODE_URL: "http://127.0.0.1:4096",
  OPENCODE_BIN: "/opt/homebrew/bin/opencode",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
};

const agents = buildLaunchdAgents({ root, home, env, nodePath: "/opt/homebrew/bin/node", opencodePath: env.OPENCODE_BIN });
assert.deepEqual(agents.map((agent) => agent.label), LAUNCHD_SERVICES.map((service) => service.label));
assert.equal(agents.length, 2, "V1 must install only OpenCode and Worker agents");

const [opencode, worker] = agents;
assert.deepEqual(opencode.plist.ProgramArguments, [
  "/opt/homebrew/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096",
]);
assert.deepEqual(worker.plist.ProgramArguments, ["/opt/homebrew/bin/node", `${root}/worker/worker.mjs`]);
assert.equal(worker.plist.EnvironmentVariables.HUB_URL, "https://mashang-hub.example.com");
assert.equal(worker.plist.EnvironmentVariables.WORKER_SECRET, "secret<&");
assert.equal(worker.plist.EnvironmentVariables.MASHANG_SERVICE_ROOT, `${home}/Documents/github/mashang-service`);
assert.equal(worker.plist.EnvironmentVariables.OPENCODE_URL, "http://127.0.0.1:4096");
for (const agent of agents) {
  assert.equal(agent.plist.RunAtLoad, true);
  assert.equal(agent.plist.KeepAlive, true);
  assert.equal(agent.plist.WorkingDirectory, agent === opencode ? `${home}/Documents/github/mashang-service` : root);
  assert.equal(agent.plist.ProgramArguments.includes("server.mjs"), false, "Hub must not be launched locally");
}
assert.match(renderPlist(worker), /secret&lt;&amp;/, "plist values must be XML-escaped");
if (process.platform === "darwin") {
  for (const agent of agents) execFileSync("plutil", ["-lint", "-"], { input: renderPlist(agent), stdio: ["pipe", "ignore", "pipe"] });
}

assert.throws(() => buildLaunchdAgents({ root, home, env: { ...env, HUB_URL: "http://mashang-hub.example.com" }, opencodePath: env.OPENCODE_BIN }), /Use HTTPS/);
assert.throws(() => buildLaunchdAgents({ root, home, env: { ...env, HUB_URL: undefined }, opencodePath: env.OPENCODE_BIN }), /HUB_URL is required/);
assert.throws(() => buildLaunchdAgents({ root, home, env: { ...env, WORKER_SECRET: "" }, opencodePath: env.OPENCODE_BIN }), /WORKER_SECRET is required/);
assert.throws(() => buildLaunchdAgents({ root, home, env: { ...env, OPENCODE_URL: "http://0.0.0.0:4096" }, opencodePath: env.OPENCODE_BIN }), /loopback/);
assert.throws(() => buildLaunchdAgents({ root, home, env: { ...env, OPENCODE_PORT: "70000" }, opencodePath: env.OPENCODE_BIN }), /OPENCODE_PORT/);

const tempDir = await mkdtemp(join(tmpdir(), "mashang-launchd-smoke-"));
try {
  const fakeLaunchctl = join(tempDir, "launchctl");
  await writeFile(fakeLaunchctl, '#!/bin/sh\ncase "$2" in gui/*/com.mashang-hub.worker) exit 0;; esac\nexit 1\n', "utf8");
  await chmod(fakeLaunchctl, 0o700);
  for (const args of [["run", "up"], ["run", "restart"]]) {
    const result = spawnSync("npm", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, LAUNCHCTL_BIN: fakeLaunchctl },
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 1, `${args.join(" ")} must refuse when the Worker LaunchAgent is active\n${output}`);
    assert.match(output, /launchd 正在托管 OpenCode \/ Mac Worker/);
    assert.match(output, /launchd:status/);
    assert.doesNotMatch(output, /opencode ready|hub ready|worker 启动/);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("launchd agent configuration checks passed");
