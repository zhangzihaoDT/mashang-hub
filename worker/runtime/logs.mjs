import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_TAIL_BYTES = 256 * 1024;
const DEFAULT_LINES = 40;

export async function resolveLogSource(source) {
  if (source.path) {
    try {
      const info = await stat(source.path);
      return { label: source.label, path: source.path, exists: true, size: info.size, mtime: info.mtime.toISOString() };
    } catch {
      return { label: source.label, path: source.path, exists: false, size: null, mtime: null };
    }
  }
  if (source.dir) {
    try {
      const pattern = source.pattern ? new RegExp(source.pattern) : null;
      const names = (await readdir(source.dir)).filter((name) => !pattern || pattern.test(name)).sort();
      const latest = names[names.length - 1];
      if (!latest) return { label: source.label, path: null, exists: false, size: null, mtime: null };
      const path = join(source.dir, latest);
      const info = await stat(path);
      return { label: source.label, path, exists: true, size: info.size, mtime: info.mtime.toISOString() };
    } catch {
      return { label: source.label, path: null, exists: false, size: null, mtime: null };
    }
  }
  return { label: source.label, path: null, exists: false, size: null, mtime: null };
}

/** Flatten every registered log source across dependencies, services and jobs. */
export async function listLogSources(registry) {
  const entries = [...(registry.dependencies || []), ...(registry.services || []), ...(registry.jobs || [])].filter((entry) => (entry.logs || []).length);
  const sources = [];
  for (const entry of entries) {
    for (const source of entry.logs) {
      sources.push({ id: entry.id, entryLabel: entry.label, ...(await resolveLogSource(source)) });
    }
  }
  return sources;
}

export async function readTail(path, lines = DEFAULT_LINES) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === "") all.pop();
    return all.slice(-lines).join("\n");
  } finally {
    await handle.close();
  }
}

/**
 * Poll a file for appended bytes and forward them to `onChunk`.
 * Returns a stop function. Truncation resets the offset.
 */
export function followFile(path, onChunk, { intervalMs = 500 } = {}) {
  let position = 0;
  let busy = false;
  let stopped = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const info = await stat(path);
      if (info.size < position) position = 0;
      if (info.size > position) {
        const length = info.size - position;
        const buffer = Buffer.alloc(length);
        const handle = await open(path, "r");
        try {
          await handle.read(buffer, 0, length, position);
        } finally {
          await handle.close();
        }
        position = info.size;
        onChunk(buffer.toString("utf8"));
      }
    } catch {
      /* File may be rotating or absent; keep polling. */
    } finally {
      busy = false;
    }
  }

  stat(path).then((info) => { position = info.size; }).catch(() => { position = 0; });
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
