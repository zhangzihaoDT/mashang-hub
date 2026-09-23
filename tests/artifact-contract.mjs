import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile("public/index.html", "utf8");
const app = await readFile("public/app.js", "utf8");
assert.match(html, /id="resultContent"/);
assert.match(html, /id="artifacts"/);
assert.match(app, /function ensureArtifactMount\(\)/);
assert.match(app, /\$\("#resultContent"\)\.innerHTML/);
assert.match(app, /artifactId=\$\{encodeURIComponent\(artifactId\)\}/);
assert.doesNotMatch(app, /function renderResult\([^)]*\)[^{]*\{[^}]*\$\("#resultBody"\)\.innerHTML/);
assert.doesNotMatch(app, /\$\("#resultBody"\)\.innerHTML/);
console.log("Artifact DOM and rendering contract checks passed");
