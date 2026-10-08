import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalArtifact } from "../worker/artifact-resolver.mjs";

const root = await mkdtemp(join(tmpdir(), "mashang-artifact-resolver-"));

try {
  await mkdir(join(root, "outputs"), { recursive: true });
  await mkdir(join(root, "dataset"), { recursive: true });
  await writeFile(join(root, "outputs", "report.csv"), "id\n1\n");
  await writeFile(join(root, "dataset", "assign_data.csv"), "date,leads\n");

  const artifact = await resolveLocalArtifact("outputs/report.csv", root);
  assert.equal(artifact?.path, "outputs/report.csv", "an existing output file remains discoverable");
  assert.equal(artifact?.type, "CSV");

  assert.equal(await resolveLocalArtifact("assign_data.csv", root), null, "a bare dataset filename is ignored");
  assert.equal(await resolveLocalArtifact("dataset/assign_data.csv", root), null, "dataset paths are never downloadable artifacts");
  assert.equal(await resolveLocalArtifact("outputs/missing.csv", root), null, "a nonexistent output candidate is ignored");

  console.log("Artifact resolver checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
