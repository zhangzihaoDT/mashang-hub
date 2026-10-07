const color = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const green = (text) => color("32", text);
const red = (text) => color("31", text);
const yellow = (text) => color("33", text);
const dim = (text) => color("2", text);

function pad(text, width) {
  const visible = [...text].length;
  return visible >= width ? text : text + " ".repeat(width - visible);
}

function truncate(text, width = 72) {
  const chars = [...String(text)];
  return chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : String(text);
}

function serviceLine(service) {
  const dot = service.online ? green("●") : red("○");
  const state = service.online ? green("online ") : red("offline");
  const raw = service.latencyMs != null ? `${service.detail} · ${service.latencyMs}ms` : service.detail;
  return `  ${dot} ${pad(service.label, 26)} ${state}  ${dim(truncate(raw))}`;
}

function jobLine(job) {
  const tone = job.status === "COMPLETED" ? green : job.status === "FAILED" ? red : yellow;
  const when = job.finishedAt || job.startedAt || "unknown";
  let detail = `last run ${when}`;
  if (job.failedStep) detail += ` · failed at ${job.failedStep} (exit ${job.failedExitCode})`;
  if (job.reason) detail += ` · ${job.reason}`;
  return `  ${tone("●")} ${pad(job.label, 26)} ${tone(job.status.padEnd(9))} ${dim(detail)}`;
}

export function renderText(status) {
  const lines = [`mashang runtime status  ${dim(status.checkedAt)}`, "", "SERVICES"];
  for (const service of status.services) lines.push(serviceLine(service));
  lines.push("", "JOBS");
  for (const job of status.jobs) lines.push(jobLine(job));
  return `${lines.join("\n")}\n`;
}
