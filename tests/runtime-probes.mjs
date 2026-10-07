import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findProcesses } from "../worker/runtime/probes.mjs";

const probesPath = fileURLToPath(new URL("../worker/runtime/probes.mjs", import.meta.url));
const token = `MASHANG_SELF_${process.pid}_${Date.now()}`;

const inline = "const token=process.argv[1]; import(process.env.PROBES_PATH).then(async (m)=>{const found=await m.findProcesses(token); console.log(JSON.stringify({self:process.pid, found}));});";
const child = spawn(process.execPath, ["-e", inline, token], {
  env: { ...process.env, PROBES_PATH: probesPath },
  stdio: ["ignore", "pipe", "inherit"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
const code = await new Promise((resolve) => child.on("exit", resolve));
assert.equal(code, 0);

const parsed = JSON.parse(output.trim().split("\n").pop());
assert.equal(parsed.found.some((entry) => entry.pid === parsed.self), true, "a process must be able to detect itself");

assert.deepEqual(await findProcesses(`NO_SUCH_PROCESS_${Date.now()}`), []);

console.log("Runtime probe process checks passed");
