import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { contentCard } from '../server/content-preview.mjs';
import { noteIntent } from '../worker/content/notes.mjs';

assert.equal(noteIntent('把这条笔记改写成微博'), null);
assert.equal(noteIntent('如何同步到 Flomo？'), null);
assert.equal(noteIntent('只整理笔记：合成内容').sync, false);
assert.equal(noteIntent('只整理，不保存：合成内容').save, false);
assert.equal(noteIntent('记下来：我想同步到 Flomo 的合成讨论').sync, false);
assert.equal(noteIntent('同步到 Flomo：合成的微博讨论').sync, true);
assert.equal(contentCard({ ref: '../escape', digest: 'a'.repeat(64) }), null);
const contentRoot = process.env.CONTENT_TEST_ROOT || fileURLToPath(new URL('../../content', import.meta.url));
const temp = await mkdtemp('/private/tmp/hub-content-');
const root = join(temp, 'content'); await mkdir(join(root, 'src'), { recursive: true });
const dataDir = join(temp, 'data'), entries = join(temp, 'entries'), callsFile = join(temp, 'calls.jsonl');
const actualNotes = pathToFileURL(join(contentRoot, 'src/notes.mjs')).href;
await copyFile(join(contentRoot, 'src/storage.mjs'), join(root, 'src/storage.mjs'));
await mkdir(join(root, 'skills/flomo-sync/references'), { recursive: true });
await copyFile(join(contentRoot, 'skills/flomo-sync/references/formatting.md'), join(root, 'skills/flomo-sync/references/formatting.md'));
await writeFile(join(root, 'src/notes.mjs'), `import {notes as realNotes,validateNote} from ${JSON.stringify(actualNotes)}; import {appendFile} from 'node:fs/promises'; export {validateNote}; export function notes(storage,input,options={}) { return realNotes(storage,input,{...options,run:async text=>{ await appendFile(${JSON.stringify(callsFile)},JSON.stringify(text)+'\\n'); if(text.includes('超时'))throw Error('synthetic timeout'); }}); }`);
const { Storage } = await import(pathToFileURL(join(root, 'src/storage.mjs')).href);
await new Storage(dataDir).locked(() => new Storage(dataDir).write('config/flomo.json', { flomo_api: 'https://flomoapp.com/iwh/synthetic-test-only' }));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
await writeFile(join(temp, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
let generation = 0, hub, worker, cookie = '', browser;
const logs = [], streams = new Set();
const oc = createServer(async (req, res) => {
  if (req.url.startsWith('/event')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': mock\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/config/providers')) return res.end(JSON.stringify({ providers: { deepseek: { id: 'deepseek', models: { mock: { id: 'mock', name: 'DeepSeek Flash 4.1' } } } } }));
  if (req.url.includes('/message') && req.method === 'POST') {
    const input = JSON.parse(body); assert.deepEqual(input.tools, { '*': false });
    const prompt = input.parts[0].text;
    if (prompt.includes('中断')) await new Promise(resolve => setTimeout(resolve, 600));
    const final = `**合成笔记 ${++generation}**\n\n${prompt.includes('超时') ? '超时' : '合成正文 <script>window.attack=1</script>'}\n\n#测试`;
    return res.end(JSON.stringify({ info: { finish: 'stop' }, parts: [{ type: 'text', text: prompt.startsWith('整理为笔记') ? JSON.stringify({ final_note: final }) : '合成微博草稿' }] }));
  }
  if (req.url.includes('/message')) return res.end(JSON.stringify([{ parts: [{ type: 'text', text: '合成讨论 #测试' }] }]));
  if (req.url.startsWith('/session') && req.method === 'POST') return res.end('{"id":"ses_content_mock"}');
  res.end('{}');
});
await new Promise(resolve => oc.listen(0, '127.0.0.1', resolve));
const port = 43000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 180; i++) { try { const value = await fn(); if (value) return value; } catch {} await sleep(40); } throw Error('Content fixture timeout: '+logs.join('').slice(-4000)); }
async function api(path, body) { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; }
async function calls() { try { return (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
function startHub() { hub = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HUB_HOST: '127.0.0.1', PORT: String(port), HUB_TASK_DB: join(temp, 'hub.sqlite'), HUB_TURN_LOG: join(temp, 'turns.jsonl'), WORKER_SECRET: 'content-test', HUB_ACCESS_TOKEN: 'synthetic-login', HUB_APPROVAL_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, stdio: ['ignore', 'ignore', 'pipe'] }); hub.stderr.on('data', c => logs.push(c.toString())); }
function startWorker() { worker = spawn(process.execPath, ['worker/worker.mjs'], { env: { ...process.env, HUB_URL: base, WORKER_SECRET: 'content-test', WORKER_ID: 'content-test', WORKER_STATE_FILE: join(temp, 'worker.json'), MASHANG_SERVICE_ROOT: temp, MYKNBASE_ROOT: temp, MASHANG_PUBLISH_ENABLED: '0', MASHANG_PUBLISH_DIRECT: '0', MASHANG_PUBLISH_SERVICE_URL: '', MASHANG_CONTENT_ENABLED: '1', MASHANG_CONTENT_ROOT: root, MASHANG_CONTENT_DATA_DIR: dataDir, MASHANG_CONTENT_NOTES_DIR: entries, MASHANG_CONTENT_PUBLIC_KEY_FILE: join(temp, 'public.pem'), OPENCODE_URL: `http://127.0.0.1:${oc.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] }); worker.stderr.on('data', c => logs.push(c.toString())); }
async function login() { await until(async () => (await fetch(base + '/api/auth/status')).ok); const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"synthetic-login"}' }); cookie = r.headers.get('set-cookie').split(';')[0]; }
async function session() { return (await api('/api/sessions', {})).data; }
async function submit(s, text, action = null, extra = {}) {
  const result = await api(`/api/sessions/${s.id}/message`, { workspaceId: 'publish', parts: [{ type: 'text', text }], contentAction: action, ...extra });
  assert.equal(result.status, 202);
  const task = await until(async () => { const t = (await api(`/api/tasks/${result.data.taskId}`)).data; return ['COMPLETED', 'FAILED'].includes(t.status) && t; });
  assert.equal(task.status, 'COMPLETED', logs.join(''));
  return { task, card: (await api(`/api/tasks/${task.taskId}/preview`)).data.contentCard };
}
async function latestControl(s) { return until(async () => (await api('/api/runtime/controls')).data.filter(c => c.conversationId === s.id).sort((a, b) => b.createdAt - a.createdAt)[0]); }
try {
  startHub(); await login(); startWorker(); await until(async () => (await api('/api/runtime')).data.snapshot?.operations?.some(o => o.id === 'notes-flomo'));
  const s = await session();
  const first = await submit(s, '整理成笔记：合成原文 #测试');
  assert.ok(first.card); assert.equal((await calls()).length, 0);
  assert.equal(first.card.notice, '');
  const saved = await submit(s, '保存', { ref: first.card.ref, action: 'save' });
  assert.equal(saved.card.notice, '已保存到本地'); assert.equal((await readdir(entries)).filter(f => f.endsWith('.md')).length, 1);
  const sync = await submit(s, '同步 Flomo', { ref: saved.card.ref, action: 'sync' });
  const c = await latestControl(s); assert.equal(c.status, 'PENDING_APPROVAL'); assert.equal((await calls()).length, 0);
  const other = await session();
  const denied = await api(`/api/sessions/${other.id}/message`, { workspaceId: 'publish', parts: [{ type: 'text', text: '保存' }], contentAction: { ref: saved.card.ref, action: 'save' } });
  await until(async () => (await api('/api/tasks/'+denied.data.taskId)).data.status === 'FAILED');
  const decision = () => api(`/api/runtime/controls/${c.controlId}/decision`, { approve: true, digest: c.digest });
  assert.equal((await api(`/api/runtime/controls/${c.controlId}/decision`, { approve: true, digest: 'a'.repeat(64) })).status, 409);
  const twice = await Promise.all([decision(), decision()]); assert.equal(twice.filter(r => r.status === 200).length, 1);
  await until(async () => (await api(`/api/runtime/controls/${c.controlId}`)).data.status === 'COMPLETED'); assert.equal((await calls()).length, 1);
  assert.ok(sync.card.notice.includes('本地'));
  const editPreview = await submit(s, '同步 Flomo', { ref: saved.card.ref, action: 'sync' });
  const stale = await latestControl(s);
  await submit(s, '**修改后的合成标题**\n\n修改后的合成正文\n\n#测试', { ref: editPreview.card.ref, action: 'edit' });
  assert.equal((await api(`/api/runtime/controls/${stale.controlId}/decision`, { approve: true, digest: stale.digest })).status, 409);
  const t = await session(); await submit(t, '保存到本地并同步 Flomo：超时合成 #测试');
  const timeout = await latestControl(t); await api(`/api/runtime/controls/${timeout.controlId}/decision`, { approve: true, digest: timeout.digest });
  await until(async () => (await api(`/api/runtime/controls/${timeout.controlId}`)).data.status === 'UNKNOWN'); assert.equal((await calls()).length, 2);
  await api(`/api/runtime/controls/${timeout.controlId}/reconcile`, {}); await sleep(80); assert.equal((await calls()).length, 2);
  worker.kill('SIGTERM'); await once(worker, 'exit'); hub.kill('SIGTERM'); await once(hub, 'exit');
  startHub(); await login(); startWorker(); await until(async () => (await api('/api/runtime')).data.snapshot?.operations?.some(o => o.id === 'notes-flomo'));
  assert.equal((await decision()).status, 409); assert.equal((await calls()).length, 2);
  assert.equal((await api(`/api/runtime/controls/${timeout.controlId}`)).data.status, 'UNKNOWN');
  assert.equal((await api(`/api/tasks/${saved.task.taskId}/preview`)).data.contentCard.notice, '已保存到本地');
  assert.equal((await api(`/api/tasks/${saved.task.taskId}/result`)).data.contentCard.notice, '已保存到本地', 'generic result survives Hub and Worker restart without execution');
  const interruptedSession = await session();
  const interrupted = await api(`/api/sessions/${interruptedSession.id}/message`, { workspaceId: 'publish', parts: [{ type: 'text', text: '保存到本地：中断合成 #测试' }] });
  await until(async () => JSON.parse(await readFile(join(temp, 'worker.json.executions.json'), 'utf8'))[interrupted.data.taskId]?.contentGeneration);
  const beforeInterruption = (await readdir(entries)).length;
  worker.kill('SIGKILL'); await once(worker, 'exit'); startWorker();
  await until(async () => (await api(`/api/tasks/${interrupted.data.taskId}`)).data.status === 'FAILED');
  assert.equal((await readdir(entries)).length, beforeInterruption);
  await until(async () => (await api('/api/runtime')).data.snapshot?.operations?.some(o => o.id === 'notes-flomo'));
  // Grant only matches the source and target supplied by this authenticated turn.
  const discussion = await session();
  await submit(discussion, '讨论一个合成方案');
  const summarized = await submit(discussion, '整理刚才的讨论');
  assert.ok(summarized.card);
  await submit(discussion, '保存', { ref: summarized.card.ref, action: 'save' });
  const records = await readdir(entries);
  const record = await Promise.all(records.filter(f => f.endsWith('.json')).map(f => readFile(join(entries, f), 'utf8').then(JSON.parse)));
  assert.ok(record.some(r => r.payload.original_content.includes('讨论一个合成方案')));
  const d = await session(); const { snapshotDigest } = await import('../server/operation-proof.mjs');
  await submit(d, '直接同步到 Flomo：直接合成 #测试', null, { scopedAuthorization: { targetId: 'notes-flomo', sourceDigest: snapshotDigest('直接合成 #测试') } });
  const direct = await latestControl(d); await until(async () => (await api(`/api/runtime/controls/${direct.controlId}`)).data.status === 'COMPLETED'); assert.equal((await calls()).length, 3);
  const wrong = await session(); await submit(wrong, '同步 Flomo：合成 #测试', null, { scopedAuthorization: { targetId: 'other-target', sourceDigest: snapshotDigest('合成 #测试') } });
  assert.equal((await latestControl(wrong)).status, 'PENDING_APPROVAL'); assert.equal((await calls()).length, 3);
  const composedSession = await session();
  const typed = '**按钮保存合成笔记**\n\n原样保存，不调用模型。\n\n#测试';
  const beforeGeneration = generation;
  const composeSaved = await submit(composedSession, typed, { action: 'save-input' }, { model: null });
  assert.ok(composeSaved.card.text.startsWith('**合成笔记'));
  assert.equal(composeSaved.card.notice, '已保存到本地');
  const savedMarkdown = await Promise.all((await readdir(entries)).filter(f => f.endsWith('.md')).map(f => readFile(join(entries, f), 'utf8')));
  assert.ok(savedMarkdown.includes(composeSaved.card.text), 'Markdown stores the organized preview exactly');
  assert.equal(generation, beforeGeneration + 1, 'local input is organized before Markdown save');
  const changed = '**按钮编辑合成笔记**\n\n手动修改后的正文。\n\n#测试';
  const composeEdited = await submit(composedSession, changed, { ref: composeSaved.card.ref, action: 'edit-save' }, { model: null });
  assert.ok(composeEdited.card.text.startsWith('**合成笔记'));
  const composeRecords = await Promise.all((await readdir(entries)).filter(f => f.endsWith('.json')).map(f => readFile(join(entries, f), 'utf8').then(JSON.parse)));
  assert.ok(composeRecords.some(r => r.payload.final_note === composeEdited.card.text && r.payload.original_content === typed));
  const composeSync = await submit(composedSession, composeEdited.card.text, { ref: composeEdited.card.ref, action: 'edit-sync' });
  assert.equal(composeSync.card.text, composeEdited.card.text);
  assert.equal(composeSync.card.notice, '已保存到本地');
  assert.equal((await latestControl(composedSession)).status, 'PENDING_APPROVAL');
  assert.equal((await calls()).length, 3);
  const spacedSession = await session();
  const spacedInput = '**列表合成笔记**\n\n- 第一项\n\n- 第二项\n\n#测试';
  const countBeforeSpacing = generation;
  const spacedPreview = await submit(spacedSession, spacedInput, { action: 'sync-input' });
  assert.equal(spacedPreview.card.text, spacedInput.replace('- 第一项\n\n- 第二项', '- 第一项\n- 第二项'));
  assert.equal(generation, countBeforeSpacing, 'list whitespace needs no model retry');
  assert.equal((await latestControl(spacedSession)).status, 'PENDING_APPROVAL');
  assert.equal((await calls()).length, 3, 'format preparation cannot send externally');
  if (process.env.CONTENT_CLI === '1') {
    if (process.env.CONTENT_BROWSER === '1') {
      const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
      browser = await chromium.launch({ headless:true, ...(process.env.CHROME_BIN ? { executablePath:process.env.CHROME_BIN } : {}) });
    }
    const { verifyContentCLI } = await import('./content-cli-flow.mjs');
    await verifyContentCLI({ base, temp, entries, api, until, browser });
    await browser?.close(); browser = null;
    // Simulate the deployed Hub before /result existed, keeping its real SSE
    // and note preview endpoints. This must still complete the Notes workflow.
    const legacy = createServer((req, res) => {
      if (req.headers.cookie && /^\/api\/tasks\/[^/]+\/result$/.test(req.url)) {
        res.writeHead(404, { 'content-type':'application/json' }); res.end('{"error":"Not found"}'); return;
      }
      const upstream = httpRequest(new URL(req.url, base), { method:req.method, headers:req.headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      req.pipe(upstream); res.on('close', () => upstream.destroy()); upstream.on('error', () => res.destroy());
    });
    await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
    try { await verifyContentCLI({ base:`http://127.0.0.1:${legacy.address().port}`, temp:join(temp,'legacy'), entries, api, until }); }
    finally { legacy.closeAllConnections(); await new Promise(resolve => legacy.close(resolve)); }
    console.log('Legacy Hub without /result: SSE discussion, note save and preview recovery passed');
  }
  console.log('Content real Hub → Worker → Content APIs with mock model/webhook: local save, exact approval, edit invalidation, cross-session denial, duplicate clicks, timeout, restart, scoped direct grant and recovery passed');
  if (process.env.CONTENT_BROWSER === '1') {
    const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.locator('#accessToken').fill('synthetic-login'); await page.locator('#loginForm button').click();
    await until(() => page.locator('#send').isEnabled());
    await page.locator('[data-workspace="publish"]').click();
    assert.equal(await page.locator('#workspaceTitle').textContent(), 'Content');
    assert.equal(await page.locator('[data-content-mode="notes"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#send').isVisible(), false);
    for (const id of ['saveNote','syncNote']) assert.equal(await page.locator('#'+id).isVisible(), true);
    assert.equal(await page.locator('#saveNote').isEnabled(), false);
    await page.locator('#prompt').fill('保留输入');
    await page.locator('[data-content-mode="publish"]').click(); assert.equal(await page.locator('#send').isVisible(), true);
    assert.equal(await page.locator('#noteComposerActions').isVisible(), false);
    await page.locator('[data-content-mode="notes"]').click();
    assert.equal(await page.locator('#prompt').inputValue(), '保留输入');
    const noteText = '**产品组合规划**\n\n用合成内容验证笔记编辑、保存与同步。\n\n#测试';
    const generationBeforeSave = generation;
    await page.locator('#prompt').fill(noteText); await page.locator('#saveNote').click();
    await page.getByText('已保存到本地', { exact: true }).last().waitFor();
    assert.equal(generation, generationBeforeSave + 1);
    assert.equal(await page.evaluate(() => window.attack), undefined);
    const before = (await calls()).length;
    assert.equal(await page.locator('#editNote').count(), 0);
    assert.equal(await page.locator('#saveNote').textContent(), '保存本地');
    assert.equal(await page.locator('.composer-buttons #noteComposerActions').count(), 1);
    assert.notEqual(await page.locator('#saveNote').evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('#syncNote').evaluate(el => getComputedStyle(el).backgroundColor));
    const edited = '**产品组合规划**\n\n手动编辑后的合成内容，分别保存本地与同步 Flomo。\n\n#测试';
    await page.locator('#prompt').fill(edited); await page.locator('#saveNote').click();
    await until(() => page.locator('#syncNote').isEnabled());
    await until(() => page.locator('#syncNote').isEnabled());
    await page.locator('#syncNote').click(); await page.locator('#approvePublication').waitFor();
    assert.equal(await page.locator('#approvePublication').textContent(), '确认同步 Flomo'); assert.equal((await calls()).length, before);
    await page.locator('[data-content-mode="publish"]').click(); await page.locator('[data-content-mode="notes"]').click();
    assert.equal(await page.locator('#approvePublication').isVisible(), true);
    await page.locator('#approvePublication').click(); await page.getByText('已同步到 Flomo', { exact: true }).waitFor(); assert.equal((await calls()).length, before + 1);
    assert.equal(await page.locator('#syncNote').isEnabled(), false);
    await page.reload(); await until(() => page.locator('#send').isEnabled()); await page.locator('[data-workspace="publish"]').click();
    await page.getByText('已同步到 Flomo', { exact: true }).waitFor(); await page.locator('.content-card').last().waitFor();
    const visible = await page.locator('body').innerText();
    assert.doesNotMatch(visible, /Worker|OpenCode|Skill|operation_|control_|snapshot|\/Users\/|Webhook|UNCERTAIN|PENDING_APPROVAL/);
    assert.equal(await page.locator('#send').isVisible(), false);
    await mkdir('.local/content-preview', { recursive: true }); await page.screenshot({ path: '.local/content-preview/desktop.png', fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(150);
      for (const id of ['contentModes','saveNote','syncNote']) assert.equal(await page.locator('#'+id).isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no mobile overflow');
    }
    await page.screenshot({ path: '.local/content-preview/mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#prompt').fill('**Enter 保存笔记**\n\n回车只保存本地。\n\n#测试');
    await page.locator('#prompt').press('Enter');
    await until(async () => generation >= generationBeforeSave + 3);
    await page.getByText('已保存到本地', { exact: true }).last().waitFor();
    assert.equal((await calls()).length, before + 1);
    assert.deepEqual(errors, []);
    console.log('Content desktop + 390/320 mobile: two Notes actions, no Send or Edit, organized local Markdown save, confirmed sync, Enter local save, reload and no overflow passed');
  }
} finally {
  if (browser) await browser.close();
  for (const child of [worker, hub]) if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  for (const stream of streams) stream.destroy(); oc.closeAllConnections(); await new Promise(r => oc.close(r)); await rm(temp, { recursive: true, force: true });
}
