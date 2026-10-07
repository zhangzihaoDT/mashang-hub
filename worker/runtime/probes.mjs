import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shortError(error) {
  const message = error?.cause?.message || error?.message || String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}

async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function httpProbe(spec, { timeoutMs = 2500 } = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetch(spec.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/plain, */*" },
    });
    return { online: response.status < 500, detail: `HTTP ${response.status}`, latencyMs: Date.now() - startedAt, url: spec.url };
  } catch (error) {
    return { online: false, detail: shortError(error), latencyMs: Date.now() - startedAt, url: spec.url };
  }
}

export async function processProbe(spec) {
  if (spec.pidFile) {
    try {
      const pid = Number((await readFile(spec.pidFile, "utf8")).trim());
      if (await pidAlive(pid)) return { online: true, detail: `pid ${pid}`, pid };
    } catch {
      /* Fall through to pattern matching. */
    }
  }
  if (spec.match) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-fl", spec.match]);
      const line = stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)[0];
      if (line) {
        const pid = Number(line.split(/\s+/)[0]);
        return { online: true, detail: line, pid: Number.isInteger(pid) ? pid : null };
      }
    } catch {
      /* pgrep exits non-zero when nothing matches. */
    }
    return { online: false, detail: "process not running" };
  }
  return { online: false, detail: "no probe configured" };
}
