import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLogSources, readTail, resolveLogSource } from "../worker/runtime/logs.mjs";
import { buildRegistry, DATED_LOG_PATTERN } from "../worker/runtime/registry.mjs";

const root = await mkdtemp(join(tmpdir(), "mashang-logs-"));
try {
  const hubRoot = join(root, "hub");
  const serviceRoot = join(root, "svc");
  const fetchRoot = join(root, "fetch");
  await mkdir(join(hubRoot, ".local/logs"), { recursive: true });
  await mkdir(join(serviceRoot, "logs/scheduler"), { recursive: true });
  await mkdir(join(fetchRoot, ".local"), { recursive: true });

  await writeFile(join(fetchRoot, ".local/app.log"), "fetch boot\n", "utf8");
  await writeFile(join(serviceRoot, "logs/scheduler/stdout.log"), "stdout stream\n", "utf8");
  await writeFile(join(serviceRoot, "logs/scheduler/2026-10-06.log"), "older\n", "utf8");
  await writeFile(join(serviceRoot, "logs/scheduler/2026-10-07.log"), "newer\n", "utf8");

  const missing = await resolveLogSource({ label: "gone", path: join(root, "nope.log") });
  assert.equal(missing.exists, false);

  const latest = await resolveLogSource({ label: "daily", dir: join(serviceRoot, "logs/scheduler"), pattern: DATED_LOG_PATTERN });
  assert.equal(latest.exists, true);
  assert.equal(latest.path, join(serviceRoot, "logs/scheduler/2026-10-07.log"));

  await writeFile(join(hubRoot, ".local/logs/big.log"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), "utf8");
  const tail = await readTail(join(hubRoot, ".local/logs/big.log"), 3);
  assert.equal(tail, "line 97\nline 98\nline 99");

  const registry = buildRegistry({
    MASHANG_HUB_ROOT: hubRoot,
    MASHANG_SERVICE_ROOT: serviceRoot,
    MASHANG_FETCH_ROOT: fetchRoot,
  });
  const sources = await listLogSources(registry);
  const ids = sources.map((source) => source.id);
  assert.ok(ids.includes("fetch"));
  assert.equal(ids.includes("worker"), false);
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("scheduler"));
  assert.ok(ids.includes("daily"));
  assert.equal(sources.find((s) => s.id === "opencode").exists, false);
  assert.equal(sources.find((s) => s.id === "daily").path, join(serviceRoot, "logs/scheduler/2026-10-07.log"));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Runtime log source checks passed");
