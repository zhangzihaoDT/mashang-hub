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

function serviceLabel(service) {
  if (!service.online) return red("offline");
  return service.managed ? green("online ") : yellow("online ");
}

function serviceLine(service) {
  const dot = service.online ? green("●") : red("○");
  const raw = service.latencyMs != null ? `${service.detail} · ${service.latencyMs}ms` : service.detail;
  const suffix = service.online && !service.managed ? dim(" (unmanaged)") : "";
  return `  ${dot} ${pad(service.label, 26)} ${serviceLabel(service)}  ${dim(truncate(raw))}${suffix}`;
}

function legacyLine(service) {
  const list = service.legacy.map((entry) => `pid ${entry.pid}`).join(", ");
  return `      ${red("⚠ legacy")} ${service.id}: ${list} ${dim("(not treated as a valid service)")}`;
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
  for (const service of status.services) {
    lines.push(serviceLine(service));
    if (service.legacy?.length) lines.push(legacyLine(service));
  }
  lines.push("", "JOBS");
  for (const job of status.jobs) lines.push(jobLine(job));
  return `${lines.join("\n")}\n`;
}
