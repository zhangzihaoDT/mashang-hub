import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { snapshotDigest } from '../server/operation-proof.mjs';

// Exercise real readline editing/prompts with a synthetic terminal and a mock
// Hub. No Worker, model, personal note directory or external send is involved.
const stateDir = await mkdtemp(join(tmpdir(), 'content-cli-modes-'));
const tasks = [], submissions = [], streams = new Set();
let logins = 0, sessions = 0, eventConnections = 0, nextOutcome = 'COMPLETED';
const server = createServer(async (req, res) => {
  if (req.url === '/api/events') {
    eventConnections++;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
    streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/api/auth/status') return reply({ required: true, authenticated: req.headers.cookie === 'sid=synthetic' });
  if (req.url === '/api/auth/login') { logins++; res.setHeader('set-cookie', 'sid=synthetic'); return reply({}); }
  if (req.url === '/api/models') return reply({ models: [{ available: true, providerID: 'deepseek', modelID: 'mock' }] });
  if (req.url === '/api/sessions') {
    if (body) { sessions++; return reply({ id: 'session-modes' }); }
    return reply(sessions ? [{ id: 'session-modes' }] : []);
  }
  if (req.url === '/api/tasks') return reply(tasks);
  if (req.url === '/api/sessions/session-modes/message') {
    submissions.push(body);
    const outcome = nextOutcome; nextOutcome = 'COMPLETED';
    if (outcome === 'OFFLINE') return reply({ error: 'synthetic unavailable' }, 503);
    const task = { taskId: `task-${tasks.length + 1}`, status: outcome === 'UNCERTAIN' ? 'COMPLETED' : outcome,
      source: 'conversation', conversationId: 'session-modes', workspaceId: 'publish', createdAt: Date.now(),
      mode: body.scopedAuthorization ? 'flomo' : 'notes', controlStatus: outcome === 'UNCERTAIN' ? 'UNKNOWN' : 'COMPLETED' };
    tasks.push(task); return reply(task);
  }
  if (req.url === '/api/runtime/controls') return reply(tasks.filter(t => t.mode === 'flomo').map(t => ({
    originTaskId: t.taskId, targetId: 'notes-flomo', status: t.controlStatus,
  })));
  const match = /^\/api\/tasks\/(task-\d+)(\/result)?$/.exec(req.url);
  if (match) {
    const task = tasks.find(t => t.taskId === match[1]);
    if (!task) return reply({ error: 'not found' }, 404);
    return reply(match[2] ? { text: '合成结果', contentCard: { title: '合成标题', notice: '已保存到本地' } } : task);
  }
  reply({ error: `unexpected route: ${req.url}` }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let cli, output = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 250; n++) { if (await check()) return; await sleep(20); }
  throw Error(`CLI condition timed out:\n${output}`);
}
function start(args = []) {
  output = '';
  cli = spawn(process.execPath, ['--input-type=module', '-e', `
    process.stdin.isTTY = true; process.stdout.isTTY = true; process.stdout.columns = 120;
    const { runContent } = await import('./cli/content.mjs');
    await runContent(process.argv.slice(1));
  `, '--', ...args, '--hub', base], {
    env: { ...process.env, TERM: 'xterm-256color', HUB_ACCESS_TOKEN: 'synthetic', MASHANG_CLI_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  cli.stdout.on('data', data => { output += stripVTControlCharacters(data.toString()); });
  cli.stderr.on('data', data => { output += data; });
}
async function send(text, expected) {
  const from = output.length;
  cli.stdin.write(text + '\n');
  if (expected) await until(() => output.slice(from).includes(expected));
}
async function switchTo(mode) {
  await send('/' + mode, `已切换到 ${mode === 'notes' ? 'Notes' : 'Flomo'}`);
  await until(() => output.trimEnd().endsWith(`${mode} ›`));
}
async function stop() {
  const exited = once(cli, 'exit'); cli.stdin.write('/exit\n'); await exited;
  assert.equal(cli.exitCode, 0, output);
}
async function profile() {
  const name = (await readdir(stateDir)).find(name => name.endsWith('.json'));
  return { path: join(stateDir, name), data: JSON.parse(await readFile(join(stateDir, name), 'utf8')) };
}
function lastSubmission(mode, text) {
  const body = submissions.at(-1);
  assert.equal(body.parts[0].text, mode === 'flomo' ? `直接同步到 Flomo：${text}` : text);
  if (mode === 'flomo') {
    assert.equal(body.contentAction, null);
    assert.deepEqual(body.scopedAuthorization, { targetId: 'notes-flomo', sourceDigest: snapshotDigest(text) });
  } else {
    assert.deepEqual(body.contentAction, { action: 'save-input' });
    assert.equal(body.scopedAuthorization, undefined);
  }
}
try {
  start(); await until(() => output.includes('Content · Notes') && output.includes('notes ›'));
  assert.equal(logins, 1); assert.equal(sessions, 1);
  await switchTo('flomo');
  await switchTo('notes');
  assert.equal(submissions.length, 0, 'switches never submit');
  assert.equal(logins, 1); assert.equal(sessions, 1); assert.equal(eventConnections, 1, 'switches reuse the same authenticated connection');

  // A manually typed prefix, multiple paste blocks, and their markers survive
  // switching. The command itself must never enter the submitted source.
  cli.stdin.write('前缀\x1b[200~第一行\n第二行\x1b[201~');
  await until(() => output.includes('[pasted~2lines]'));
  await send('/flomo', '未提交内容已保留');
  assert.ok(output.includes('flomo › 前缀[pasted~2lines]'));
  cli.stdin.write('中间\x1b[200~第三行\n第四行\x1b[201~');
  await until(() => output.includes('中间[pasted~2lines]'));
  await send('/both', '暂不支持 /both');
  assert.equal(submissions.length, 0);
  await sleep(100);
  await send('尾部', '✓ 已同步到 Flomo');
  lastSubmission('flomo', '前缀\n第一行\n第二行\n中间\n第三行\n第四行\n尾部');

  // A running submission and its eventual result retain their original target.
  nextOutcome = 'RUNNING';
  await send('运行中的 Flomo', '正在整理并同步');
  await until(() => tasks.at(-1)?.status === 'RUNNING');
  const running = tasks.at(-1);
  await switchTo('notes');
  await send('忙时输入的草稿', '未提交内容已保留');
  const count = submissions.length;
  running.status = 'COMPLETED';
  await until(() => output.includes('标题：合成标题\n\nnotes › 忙时输入的草稿'));
  assert.equal(submissions.length, count, 'buffered content waits for Enter');
  await send('', '✓ 已保存到本地');
  lastSubmission('notes', '忙时输入的草稿');

  // Both directions: failed text retries use the original action and scope.
  for (const mode of ['notes', 'flomo']) {
    await switchTo(mode);
    nextOutcome = 'FAILED';
    const text = `${mode} 失败原文`;
    await send(text, `按 Enter 重试 ${mode === 'notes' ? 'Notes' : 'Flomo'}`);
    await switchTo(mode === 'notes' ? 'flomo' : 'notes');
    await send('', mode === 'notes' ? '✓ 已保存到本地' : '✓ 已同步到 Flomo');
    lastSubmission(mode, text);
  }

  // Dispatch rejection also retains the submitted target before a task exists.
  await switchTo('flomo'); nextOutcome = 'OFFLINE';
  await send('离线原文', '内容已保留，按 Enter 重试');
  await switchTo('notes');
  await send('', '✓ 已同步到 Flomo'); lastSubmission('flomo', '离线原文');

  // Unknown external outcome only rechecks, even after switching to Notes.
  await switchTo('flomo'); nextOutcome = 'UNCERTAIN';
  await send('不确定的合成同步', '按 Enter 重新检查 Flomo');
  await switchTo('notes');
  const beforeCheck = submissions.length;
  await send('', '按 Enter 重新检查 Flomo');
  assert.equal(submissions.length, beforeCheck);
  assert.ok(output.trimEnd().endsWith('notes ›'));
  await stop();
  let saved = await profile();
  assert.equal(saved.data.contentTarget, 'notes'); assert.equal(saved.data.lastTarget, 'flomo');
  assert.equal(saved.data.sessionId, 'session-modes');
  assert.ok(!JSON.stringify(saved.data).includes('合成同步'), 'profile does not persist note content');

  start(); await until(() => output.includes('Content · Notes') && output.includes('按 Enter 重新检查 Flomo'));
  assert.equal(submissions.length, beforeCheck, 'restart checks the original Flomo task without submitting');
  assert.equal(logins, 1); assert.equal(sessions, 1);
  await switchTo('flomo'); await stop();
  start(); await until(() => output.includes('Content · Flomo') && output.includes('按 Enter 重新检查 Flomo'));
  await stop();
  start(['notes']); await until(() => output.includes('Content · Notes') && output.includes('按 Enter 重新检查 Flomo'));
  await stop();

  // Invalid/legacy saved mode safely defaults to Notes; explicit mode wins.
  saved = await profile(); delete saved.data.contentTarget; delete saved.data.lastTaskId;
  await writeFile(saved.path, JSON.stringify(saved.data));
  start(); await until(() => output.includes('Content · Notes')); await stop();
  assert.equal(submissions.length, beforeCheck);
  console.log('Content CLI modes: startup, prompts, same login/session, drafts, in-flight results, target-bound retry/recheck and restart passed');
} finally {
  if (cli?.exitCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await exited; }
  for (const stream of streams) stream.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
}
