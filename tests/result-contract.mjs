import assert from "node:assert/strict";
import { hasResult } from "../server/result-contract.mjs";

assert.equal(hasResult({ hasText: true, artifactCount: 0 }), true);
assert.equal(hasResult({ hasText: false, artifactCount: 1 }), true);
assert.equal(hasResult({ hasText: false, artifactCount: 0 }), false);
assert.equal(hasResult({ hasText: false, artifactCount: 0, text: "" }), false);
console.log("Result contract checks passed");
