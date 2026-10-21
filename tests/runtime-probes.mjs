import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findProcesses, isGroupAlive } from "../worker/runtime/probes.mjs";

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

const childCode = "setInterval(()=>{},1000)";
const leaderCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),200);`;
const leader = spawn(process.execPath, ["-e", leaderCode], { detached: true, stdio: "ignore" });
leader.unref();
try {
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await isGroupAlive(leader.pid), true, "child keeps the detached group alive after the leader exits");
  process.kill(-leader.pid, "SIGKILL");
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = await isGroupAlive(leader.pid);
  }
  assert.equal(alive, false, "SIGKILL to the group removes the remaining child");
} finally {
  try { process.kill(-leader.pid, "SIGKILL"); } catch { /* already gone */ }
}

console.log("Runtime probe process checks passed");
