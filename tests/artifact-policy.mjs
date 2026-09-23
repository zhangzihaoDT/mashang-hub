import assert from "node:assert/strict";
import { isAllowedArtifactPath } from "../worker/artifact-policy.mjs";

assert.equal(isAllowedArtifactPath("outputs/reports/report.md"), true);
assert.equal(isAllowedArtifactPath("mashang_workspace/outputs/reports/report.md"), true);
assert.equal(isAllowedArtifactPath("dataset/order_data.csv"), false);
assert.equal(isAllowedArtifactPath("dataset/raw/report.md"), false);
assert.equal(isAllowedArtifactPath("outputs_backup/report.md"), false);
console.log("Artifact output policy checks passed");
