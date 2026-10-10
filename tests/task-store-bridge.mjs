import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const directory = mkdtempSync(join(tmpdir(), 'hub-restart-'));
const port = 40000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, ws;
async function api(path, value) { const res = await fetch(base + path, { method: value ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: value ? JSON.stringify(value) : undefined }); assert.ok(res.ok, `${path}: ${res.status}`); return res.json(); }
async function start() {
  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HUB_HOST: '127.0.0.1', PORT: String(port), HUB_TASK_DB: join(directory, 'tasks.sqlite'), HUB_TURN_LOG: join(directory, 'turns.jsonl'), HUB_ACCESS_TOKEN: '', WORKER_SECRET: 'test', TASK_TIMEOUT_MS: '60000' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) return; } catch {} await sleep(50); } throw new Error('Hub did not start');
}
async function stop() { const exit = once(server, 'exit'); server.kill('SIGKILL'); await exit; }
async function worker() {
  ws = new WebSocket(base.replace('http:', 'ws:') + '/worker', { headers: { Authorization: 'Bearer test' } }); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'worker.register', workerId: 'worker1', models: [] }));
  ws.send(JSON.stringify({ type: 'runtime.snapshot', protocolVersion: 1, workerId: 'worker1', sequence: 1, generatedAt: new Date().toISOString(), services: [{ id: 'service1', label: 'Service', status: 'ONLINE' }], jobs: [], operations: [], dependencies: [] }));
  await sleep(100);
}
try {
  await start(); await worker();
  const session = await api('/api/sessions', { title: 'test' });
  const task = await api(`/api/sessions/${session.id}/message`, { model: { providerID: 'mock', modelID: 'mock' }, parts: [{ type: 'text', text: 'private input' }] });
  ws.send(JSON.stringify({ type: 'task.running', taskId: task.taskId }));
  const approval = await api('/api/runtime/control', { op: 'up', targetId: 'service1' });
  await sleep(100); await stop(); ws.terminate();
  await start();
  assert.equal((await api('/api/sessions'))[0].id, session.id);
  const recovered = await api(`/api/tasks/${task.taskId}`);
  assert.equal(recovered.status, 'INTERRUPTED'); assert.ok(recovered.dispatchId);
  assert.equal((await api(`/api/runtime/controls/${approval.controlId}`)).status, 'AWAITING_PERMISSION');
  assert.equal((await api(`/api/tasks/${approval.controlId}`)).status, 'AWAITING_APPROVAL');
  await worker();
  let dispatched = 0; ws.on('message', raw => { if (['task.create', 'runtime.control.request'].includes(JSON.parse(raw).type)) dispatched++; });
  await sleep(150); assert.equal(dispatched, 0, 'restart must not replay any dispatched or pending task');
  await api(`/api/runtime/controls/${approval.controlId}/decision`, { approve: false });
  await stop(); ws.terminate(); await start();
  assert.equal((await api(`/api/runtime/controls/${approval.controlId}`)).status, 'REJECTED');
  console.log('Hub process restart preserves tasks, conversation, pending and rejected approvals without replay');
} finally { ws?.terminate(); if (server?.exitCode === null) await stop(); rmSync(directory, { recursive: true, force: true }); }
