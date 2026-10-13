import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
const temp = mkdtempSync(join(tmpdir(), 'hub-permission-'));
const port = 39000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hub = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HUB_HOST: '127.0.0.1', HUB_TASK_DB: ':memory:', HUB_TURN_LOG: join(temp, 'turns.jsonl'), HUB_ACCESS_TOKEN: '', WORKER_SECRET: 'permission-test' }, stdio: ['ignore', 'ignore', 'pipe'] });
hub.stderr.on('data', chunk => process.stderr.write(chunk));
let worker, browser;
async function api(path, body) { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; }
async function until(fn) { for (let n = 0; n < 100; n++) { try { const result = await fn(); if (result) return result; } catch {} await sleep(20); } throw Error('fixture timed out'); }
try {
  await until(async () => (await api('/api/health')).status === 200);
  worker = new WebSocket(base.replace('http:', 'ws:') + '/worker', { headers: { Authorization: 'Bearer permission-test' } }); await once(worker, 'open');
  const received = []; worker.on('message', raw => received.push(JSON.parse(raw)));
  let currentTask;
  const send = event => worker.send(JSON.stringify(event.taskId && currentTask ? { attemptId: currentTask.attemptId, dispatchId: currentTask.dispatchId, ...event } : event));
  send({ type: 'worker.register', workerId: 'permission-worker', taskProtocolVersion: 1, status: 'ONLINE', models: [] });
  await sleep(40);
  const session = (await api('/api/sessions', { title: 'test' })).data;
  await api(`/api/sessions/${session.id}/message`, { parts: [{ type: 'text', text: 'draw' }], model: { providerID: 'mock', modelID: 'mock' }, policy: { executionDeadlineMs: 500 } });
  const task = await until(() => received.find(p => p.type === 'task.create'));
  currentTask = task;
  send({ type: 'task.running', taskId: task.taskId });
  send({ type: 'permission.requested', taskId: task.taskId, requestId: 'permission1', request: { sessionID: 'opencode-session', permission: 'external_directory', patterns: ['/styles/*'] } });
  await until(async () => (await api('/api/permissions')).data.length === 1);
  send({ type: 'permission.requested', taskId: task.taskId, attemptId: 'old-attempt', dispatchId: 'old-dispatch', requestId: 'stale', request: { sessionID: 'opencode-session' } });
  await sleep(40); assert.equal((await api('/api/permissions')).data.length, 1, 'stale execution identity must be ignored');
  await sleep(700); assert.equal(received.some(p => p.type === 'task.cancel'), false, 'approval waiting must pause execution deadline');
  const pending = (await api('/api/permissions')).data[0]; assert.equal(pending.sessionId, session.id);
  // A new SSE connection must receive pending approvals.
  const controller = new AbortController();
  const stream = await fetch(base + '/api/events', { signal: controller.signal });
  const reader = stream.body.getReader(); let snapshot = '';
  while (!snapshot.includes('permission.requested')) snapshot += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  assert.match(snapshot, /permission1/);
  if (process.env.PERMISSION_BROWSER) {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(id => localStorage.setItem('mashang-hub-session', id), session.id);
    await page.goto(base);
    await page.waitForSelector('[data-choice="once"]');
    assert.match(await page.locator('.tool-permission').textContent(), /任务暂停.*需要你的授权/);
    await page.locator('[data-choice="once"]').click();
    const click = await until(() => received.find(p => p.type === 'permission.reply'));
    assert.equal(await page.locator('[data-choice="once"]').isDisabled(), true);
    send({ type: 'permission.reply.result', taskId: task.taskId, requestId: 'permission1', replyId: click.replyId, ok: false, error: 'mock failure' });
    await page.waitForFunction(() => document.querySelector('.tool-permission')?.textContent.includes('审批未完成'));
    assert.equal(await page.locator('[data-choice="once"]').isEnabled(), true);
    await page.reload(); await page.waitForSelector('[data-choice="once"]');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: '/tmp/hub-permission-mobile.png', fullPage: true });
    // Remove the browser click from the API acknowledgement assertions below.
    received.splice(received.indexOf(click), 1);
    await browser.close(); browser = null;
  }
  assert.equal((await api('/api/permissions/permission1/reply', { response: 'invalid' })).status, 400);
  let complete = false;
  const reply = api('/api/permissions/permission1/reply', { response: 'once' }).then(value => { complete = true; return value; });
  const command = await until(() => received.find(p => p.type === 'permission.reply'));
  await sleep(60); assert.equal(complete, false, 'must wait for executor acknowledgement');
  assert.equal(command.taskId, task.taskId); assert.equal(command.attemptId, task.attemptId); assert.equal(command.dispatchId, task.dispatchId);
  send({ type: 'permission.reply.result', taskId: task.taskId, attemptId: 'old-attempt', dispatchId: 'old-dispatch', requestId: 'permission1', replyId: command.replyId, ok: true });
  await sleep(40); assert.equal(complete, false, 'late acknowledgement from another execution must not settle approval');
  send({ type: 'permission.reply.result', taskId: task.taskId, requestId: 'permission1', replyId: command.replyId, ok: false, error: 'retry' });
  assert.equal((await reply).status, 502); assert.equal((await api('/api/permissions')).data.length, 1);
  const retry = api('/api/permissions/permission1/reply', { response: 'once' });
  const second = await until(() => received.filter(p => p.type === 'permission.reply')[1]);
  send({ type: 'permission.resolved', requestId: 'permission1', taskId: task.taskId });
  send({ type: 'permission.reply.result', taskId: task.taskId, requestId: 'permission1', replyId: second.replyId, ok: true });
  assert.equal((await retry).status, 200); assert.equal((await api('/api/permissions')).data.length, 0);
  await until(() => received.some(p => p.type === 'task.cancel')); // Remaining budget resumes.
  assert.equal((await api('/api/permissions/permission1/reply', { response: 'once' })).status, 409);
  console.log('Hub approval acknowledgement, retry, SSE recovery and deadline pause/resume passed');
} finally { await browser?.close(); worker?.terminate(); if (hub.exitCode === null) { const exited = once(hub, 'exit'); hub.kill('SIGKILL'); await exited; } rmSync(temp, { recursive: true, force: true }); }
