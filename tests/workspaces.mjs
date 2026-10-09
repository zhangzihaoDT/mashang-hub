import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaces, resolveWorkspace, publicWorkspaceList, DEFAULT_WORKSPACE_ID } from "../worker/workspaces.mjs";

const env = { MASHANG_SERVICE_ROOT: "/tmp/svc", MYKNBASE_ROOT: "/tmp/kn" };
const workspaces = buildWorkspaces(env);

const fallback = workspaces.get(DEFAULT_WORKSPACE_ID);
assert.equal(fallback.root, "/tmp/svc", "default workspace derives from MASHANG_SERVICE_ROOT");
assert.deepEqual(fallback.outputRoots, ["outputs", "mashang_workspace/outputs"]);

const myknbase = workspaces.get("myknbase");
assert.equal(myknbase.root, "/tmp/kn", "myknbase workspace derives from MYKNBASE_ROOT");
assert.deepEqual(myknbase.outputRoots, ["processed"]);

assert.equal(resolveWorkspace(workspaces, undefined).id, DEFAULT_WORKSPACE_ID, "missing id falls back to default");
assert.equal(resolveWorkspace(workspaces, "").id, DEFAULT_WORKSPACE_ID, "empty id falls back to default");
assert.equal(resolveWorkspace(workspaces, "myknbase").root, "/tmp/kn");
assert.equal(resolveWorkspace(workspaces, "nope"), null, "unknown workspace resolves to null");

const list = publicWorkspaceList(workspaces);
assert.deepEqual(list.map((workspace) => workspace.id).sort(), ["default", "myknbase"]);
assert.ok(list.every((workspace) => !("root" in workspace) && !("outputRoots" in workspace)), "only id and label are public");

const dir = await mkdtemp(join(tmpdir(), "mashang-workspaces-"));
try {
  const configPath = join(dir, "workspaces.json");
  await writeFile(configPath, JSON.stringify({ workspaces: [{ id: "custom", label: "Custom", root: "/tmp/custom", outputRoots: ["out"] }] }));
  const withConfig = buildWorkspaces({ ...env, MASHANG_WORKSPACES_CONFIG: configPath });
  assert.equal(withConfig.get("custom").root, "/tmp/custom");
  assert.deepEqual(withConfig.get("custom").outputRoots, ["out"]);
  assert.equal(withConfig.get("custom").label, "Custom");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("Workspace registry checks passed");
