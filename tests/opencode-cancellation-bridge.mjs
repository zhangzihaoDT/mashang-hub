import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'hub-cancel-'));
const port = 46000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let hub, worker, output = '', sequence = 0;
const sessions = new Map(), events = [], streams = new Set();
const oc = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (path === '/config/providers') return res.end('{"providers":{}}');
  if (path === '/session' && req.method === 'POST') {
    const id = `session-${++sequence}`; sessions.set(id, { messages: [], busy: false }); return res.end(JSON.stringify({ id }));
  }
  if (path === '/session/status') return res.end(JSON.stringify(Object.fromEntries([...sessions].filter(([, s]) => s.busy).map(([id]) => [id, { type: 'busy' }]))));
  const match = path.match(/^\/session\/([^/]+)\/(message|abort)$/);
  if (!match) return res.end('{}');
  const [ , id, op ] = match, session = sessions.get(id);
  if (op === 'abort') {
    events.push({ id, op: 'abort' });
    if (session.mode !== 'stop') { res.statusCode = 503; return res.end('{"error":"abort unavailable"}'); }
    session.busy = false; clearTimeout(session.timer);
    const reply = { info: { role: 'assistant', parentID: session.userId, error: { name: 'MessageAbortedError' }, time: { completed: Date.now() } }, parts: [] };
    session.messages.push(reply); session.response.end(JSON.stringify(reply)); return res.end('true');
  }
  if (req.method === 'GET') return res.end(JSON.stringify(session.messages));
  const input = JSON.parse(body), mode = input.parts[0].text;
  assert.match(input.system, /runtime_execution/);
  assert.match(input.system, /不得擅自进入开发流程/);
  assert.equal(input.tools.edit, false);
  assert.equal(input.tools.write, true);
  assert.match(input.system, /python -c/);
  assert.match(input.system, /Git 暂存、提交、推送/);
  assert.equal(input.tools.apply_patch, false);
  events.push({ id, op: 'prompt' }); session.mode = mode; session.userId = input.messageID;
  session.messages.push({ info: { id: input.messageID, role: 'user' }, parts: [] }); session.busy = true; session.response = res;
  // A final answer from a previous turn must never be recovered for this request.
  session.messages.unshift({ info: { role: 'assistant', parentID: 'previous-user', finish: 'stop', time: { completed: Date.now() } }, parts: [{ type: 'text', text: 'WRONG previous result' }] });
  if (mode === 'drop') res.destroy();
  if (mode === 'auto') setTimeout(() => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: 'message.part.updated', properties: { part: { sessionID: id, type: 'tool', tool: 'edit', state: { status: 'running' } } } })}\n\n`); }, 40);
  session.timer = setTimeout(() => {
    session.busy = false;
    const reply = { info: { role: 'assistant', parentID: input.messageID, finish: 'stop', time: { completed: Date.now() } }, parts: [{ type: 'text', text: `recovered ${mode}` }] };
    session.messages.push(reply); if (!res.destroyed) res.end(JSON.stringify(reply));
  }, mode === 'restart' ? 3200 : 1800);
});
await new Promise(resolve => oc.listen(0, '127.0.0.1', resolve));
const common = { ...process.env, HUB_ACCESS_TOKEN: '', WORKER_SECRET: 'test-cancel', MASHANG_PUBLISH_ENABLED: '0', MASHANG_PUBLISH_DIRECT: '0', MASHANG_PUBLISH_SERVICE_URL: '' };
function watch(child) { child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data); return child; }
function startWorker() {
  worker = watch(spawn(process.execPath, ['worker/worker.mjs'], { env: { ...common, HUB_URL: base, MASHANG_SERVICE_ROOT: directory, MYKNBASE_ROOT: directory, OPENCODE_URL: `http://127.0.0.1:${oc.address().port}`, WORKER_STATE_FILE: join(directory, 'worker.json'), WORKER_HEARTBEAT_MS: '100', RUNTIME_SNAPSHOT_INTERVAL_MS: '600000' }, stdio: ['ignore', 'pipe', 'pipe'] }));
}
async function api(path, data) { const res = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); assert.ok(res.ok, `${path} ${res.status}`); return res.json(); }
async function until(fn, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch {} await sleep(30); } throw Error(`Timeout\n${output.slice(-5000)}`); }
async function stop(child) { if (child?.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } }
async function submit(mode, deadline) {
  const promptCount = events.filter(event => event.op === 'prompt').length;
  const session = await api('/api/sessions', {});
  const task = await api(`/api/sessions/${session.id}/message`, { parts: [{ type: 'text', text: mode }], policy: { executionDeadlineMs: deadline, progressTimeoutMs: 100 } });
  await until(() => events.filter(event => event.op === 'prompt').length > promptCount);
  return task;
}
try {
  hub = watch(spawn(process.execPath, ['server.mjs'], { env: { ...common, PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TASK_DB: join(directory, 'tasks.sqlite'), HUB_TURN_LOG: join(directory, 'turns.jsonl'), TASK_CANCEL_GRACE_MS: '80', TASK_TIMEOUT_MS: '300', TASK_VERIFIED_EXECUTION_DEADLINE_MS: '3000' }, stdio: ['ignore', 'pipe', 'pipe'] }));
  await until(() => api('/api/health')); startWorker(); await until(async () => (await api('/api/health')).worker?.id);
  const stopped = await submit('stop', 300);
  await until(async () => (await api(`/api/tasks/${stopped.taskId}`)).legacyStatus === 'TIMEOUT');
  assert.ok(events.some(event => event.op === 'abort'), 'must call the OpenCode abort endpoint');
  assert.equal(sessions.get('session-1').busy, false);
  const late = await submit('late', 300);
  await until(async () => (await api(`/api/tasks/${late.taskId}`)).status === 'INTERRUPTED');
  await until(async () => (await api(`/api/tasks/${late.taskId}`)).status === 'COMPLETED');
  assert.equal((await api(`/api/tasks/${late.taskId}`)).hasText, true);
  const dropped = await submit('drop', 10000);
  await until(async () => (await api(`/api/tasks/${dropped.taskId}`)).status === 'INTERRUPTED');
  await until(async () => (await api(`/api/tasks/${dropped.taskId}`)).status === 'COMPLETED');
  const automatic = await submit('auto');
  await until(async () => (await api(`/api/tasks/${automatic.taskId}`)).policy.executionClass === 'verified');
  assert.equal((await api(`/api/tasks/${automatic.taskId}`)).policy.executionDeadlineMs, 3000);
  await until(async () => (await api(`/api/tasks/${automatic.taskId}`)).status === 'COMPLETED');
  const resumed = await submit('restart', 10000);
  await stop(worker); startWorker();
  await until(async () => (await api(`/api/tasks/${resumed.taskId}`)).status === 'COMPLETED');
  assert.equal(events.filter(event => event.op === 'prompt').length, 5, 'recovery must not replay prompts');
  console.log('Hub + Worker: verified stop, rejected abort + late result, dropped HTTP + result recovery, automatic edit budget promotion, Worker restart + one execution passed');
} finally {
  await stop(worker); await stop(hub);
  for (const session of sessions.values()) clearTimeout(session.timer);
  for (const stream of streams) stream.destroy(); oc.closeAllConnections();
  await new Promise(resolve => oc.close(resolve)); rmSync(directory, { recursive: true, force: true });
}
