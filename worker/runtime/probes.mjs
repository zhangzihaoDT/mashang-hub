import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function shortError(error) {
  const message = error?.cause?.message || error?.message || String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Return every process whose full command matches `pattern` (pgrep -f). */
export async function findProcesses(pattern) {
  if (!pattern) return [];
  try {
    const { stdout } = await execFileAsync("pgrep", ["-fl", pattern]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
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
    return { online: response.status < 500, detail: `HTTP ${response.status}`, latencyMs: Date.now() - startedAt, url: spec.url, pid: null };
  } catch (error) {
    return { online: false, detail: shortError(error), latencyMs: Date.now() - startedAt, url: spec.url, pid: null };
  }
}

export async function processProbe(spec) {
  if (spec.pidFile) {
    try {
      const pid = Number((await readFile(spec.pidFile, "utf8")).trim());
      if (await isPidAlive(pid)) return { online: true, detail: `pid ${pid}`, pid };
    } catch {
      /* Fall through to signature matching. */
    }
  }
  const matches = await findProcesses(spec.match);
  if (matches.length) {
    return { online: true, detail: matches[0].command, pid: matches[0].pid, pids: matches.map((entry) => entry.pid) };
  }
  return { online: false, detail: "process not running", pid: null, pids: [] };
}
