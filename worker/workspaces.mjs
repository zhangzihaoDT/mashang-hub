import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_OUTPUT_ROOTS = ["outputs", "mashang_workspace/outputs"];

function normalizeOutputRoot(value) {
  return String(value || "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
}

function normalizeEntry(entry, fallbackOutputRoots = DEFAULT_OUTPUT_ROOTS) {
  if (!entry || typeof entry !== "object") return null;
  const id = entry.id == null ? "" : String(entry.id).trim();
  const root = entry.root == null ? "" : String(entry.root).trim();
  if (!id || !root) return null;
  const outputRoots = Array.isArray(entry.outputRoots)
    ? entry.outputRoots.map(normalizeOutputRoot).filter(Boolean)
    : [];
  return {
    id,
    label: entry.label ? String(entry.label) : id,
    root,
    outputRoots: outputRoots.length ? outputRoots : [...fallbackOutputRoots],
  };
}

function loadConfig(path) {
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.workspaces)) return parsed.workspaces;
  } catch {
    /* Optional config; ignore unreadable or invalid files. */
  }
  return [];
}

/**
 * Build the local workspace registry.
 *
 * A workspace is a local project directory that an OpenCode Session runs in.
 * The Hub never sees these roots; it only forwards an opaque `workspaceId`.
 * Machine specifics come from the environment or an optional JSON config
 * (`MASHANG_WORKSPACES_CONFIG`), never from the Hub.
 */
export function buildWorkspaces(env = process.env) {
  const serviceRoot = env.MASHANG_SERVICE_ROOT || join(homedir(), "Documents/github/mashang-service");
  const myknbaseRoot = env.MYKNBASE_ROOT || join(homedir(), "Documents/github/mashang-knbase");

  const byId = new Map();
  byId.set(DEFAULT_WORKSPACE_ID, {
    id: DEFAULT_WORKSPACE_ID,
    label: "mashang-service",
    root: serviceRoot,
    outputRoots: [...DEFAULT_OUTPUT_ROOTS],
  });
  byId.set("myknbase", {
    id: "myknbase",
    label: "mashang-knbase",
    root: myknbaseRoot,
    outputRoots: ["processed"],
  });

  if (env.MASHANG_PUBLISH_ENABLED === "1") byId.set("publish", {
    id: "publish", label: "mashang-publish", root: env.MASHANG_PUBLISH_ROOT || join(homedir(), "Documents/github/mashang-publish"),
    outputRoots: [],
  });

  for (const entry of loadConfig(env.MASHANG_WORKSPACES_CONFIG)) {
    const normalized = normalizeEntry(entry);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return byId;
}

/**
 * Resolve an incoming opaque workspace id. Missing or empty ids fall back to
 * the default workspace so existing callers keep working. Unknown ids return
 * null; the Worker treats that as a neutral rejection, not a business error.
 */
export function resolveWorkspace(workspaces, workspaceId) {
  const id = workspaceId == null || workspaceId === "" ? DEFAULT_WORKSPACE_ID : String(workspaceId);
  return workspaces.get(id) || null;
}

/** Advertise only generic identity to the Hub: opaque id plus a display label. */
export function publicWorkspaceList(workspaces) {
  return [...workspaces.values()].map((workspace) => ({ id: workspace.id, label: workspace.label }));
}
