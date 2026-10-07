import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRegistry } from "../worker/runtime/registry.mjs";
import { up, down, run, findService, findJob } from "../worker/runtime/control.mjs";
import { probeService } from "../worker/runtime/status.mjs";

const silent = { log() {}, warn() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = await mkdtemp(join(tmpdir(), "mashang-control-"));
const token = `MASHANG_CTRL_${process.pid}_${Date.now()}`;
const legacyToken = `MASHANG_LEGACY_${process.pid}_${Date.now()}`;
let legacyChild = null;

const registry = buildRegistry({ MASHANG_HUB_ROOT: root }, {
  runtimeDir: join(root, "runtime"),
  verifyMs: 8000,
  probeTimeoutMs: 1500,
  services: [
    {
      id: "scenario",
      label: "scenario",
      probe: { type: "process", match: token },
      match: token,
      legacy: [legacyToken],
      control: {
        start: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", token], cwd: root, detach: true },
        stop: { signal: "SIGTERM", timeoutMs: 3000 },
      },
    },
  ],
  jobs: [
    { id: "okjob", label: "okjob", probe: { type: "noop" }, control: { run: { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root } } },
    { id: "failjob", label: "failjob", probe: { type: "noop" }, control: { run: { command: process.execPath, args: ["-e", "process.exit(3)"], cwd: root } } },
  ],
});

const service = findService(registry, "scenario");
const probeOptions = { timeoutMs: 1500, stateDir: registry.runtimeDir };

try {
  const first = await up(service, registry, { log: silent });
  assert.equal(first.status, "started");

  const online = await probeService(service, probeOptions);
  assert.equal(online.online, true);
  assert.equal(online.managed, true);

  const second = await up(service, registry, { log: silent });
  assert.equal(second.status, "already-running");
  assert.equal(second.managed, true);

  const stopped = await down(service, registry, { log: silent });
  assert.equal(stopped.status, "stopped");
  const offline = await probeService(service, probeOptions);
  assert.equal(offline.online, false);
  assert.equal(offline.managed, false);

  const again = await down(service, registry, { log: silent });
  assert.equal(again.status, "already-stopped");

  legacyChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", legacyToken], { stdio: "ignore" });
  legacyChild.unref();
  await sleep(600);

  const legacyOnly = await probeService(service, probeOptions);
  assert.equal(legacyOnly.online, false);
  assert.equal(legacyOnly.legacy.length >= 1, true);

  const startedDespiteLegacy = await up(service, registry, { log: silent });
  assert.equal(startedDespiteLegacy.status, "started");
  const both = await probeService(service, probeOptions);
  assert.equal(both.online, true);
  assert.equal(both.managed, true);
  assert.equal(both.legacy.length >= 1, true);
  await down(service, registry, { log: silent });

  const okResult = await run(findJob(registry, "okjob"), registry, { log: silent });
  assert.equal(okResult.status, "completed");
  assert.equal(okResult.code, 0);

  const failResult = await run(findJob(registry, "failjob"), registry, { log: silent });
  assert.equal(failResult.status, "failed");
  assert.equal(failResult.code, 3);

  console.log("Runtime control checks passed");
} finally {
  await down(service, registry, { log: silent }).catch(() => {});
  if (legacyChild?.pid) {
    try { process.kill(legacyChild.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await rm(root, { recursive: true, force: true });
}
