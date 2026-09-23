import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(here, "..", "public", "index.html"), "utf8");
const app = await readFile(join(here, "..", "public", "app.js"), "utf8");
const required = ["connection", "sessionMeta", "messages", "runState", "resultBody", "resultContent", "promptForm", "prompt", "modelSelect", "send", "cancel"];
const optional = ["artifacts", "debug", "debugToggle", "debugClose", "debugContent", "loginOverlay", "loginForm", "accessToken", "loginError"];
const hasID = (id) => new RegExp(`id=["']${id}["']`).test(html);
const referenced = (id) => app.includes(`#${id}`);
const htmlIDs = [...html.matchAll(/id=["']([^"']+)["']/g)].map((match) => match[1]);
const missing = required.filter((id) => !hasID(id));
if (missing.length) throw new Error(`Missing required DOM IDs: ${missing.join(", ")}`);
console.log(`Required DOM: ${required.join(", ")}`);
console.log(`Optional DOM: ${optional.filter(hasID).join(", ") || "none"}`);
console.log(`Missing optional DOM: ${optional.filter((id) => !hasID(id)).join(", ") || "none"}`);
console.log(`Unused DOM: ${htmlIDs.filter((id) => !referenced(id)).join(", ") || "none"}`);
