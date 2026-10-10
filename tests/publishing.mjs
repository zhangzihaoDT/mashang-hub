import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishGate, parseIntent, runPublish, TOOL_DENIAL, verifiedToolDenial } from '../worker/publishing/gate.mjs';
const directory = await mkdtemp(join(tmpdir(), 'publish-gate-'));
const signal = new AbortController().signal;
const actor = { kind: 'user', authenticated: true };
let calls = 0; let captured; let now = 1000;
const execute = async args => { calls++; captured = args.draft; return { status: 'PUBLISHED', idstr: '1234567890123456789', url: 'https://weibo.com/detail/1234567890123456789' }; };
const gate = new PublishGate({ directory, root: '/mock', execute, now: () => now });
const task = (prompt, confirmationId, extra = {}) => ({ sessionId: 's1', taskId: 't1', actor, prompt, confirmationId, ...extra });
const text = '引号 "\' $HOME $(touch /private/tmp/should-not-exist) `echo hi`\n正文 <>&';
assert.equal(parseIntent('解释微博如何发布'), null);
assert.equal(parseIntent(`发布微博[private,ai]：${text}`).text, text);
assert.throws(() => parseIntent('发布微博：--flag'));
assert.equal(await gate.handle(task('普通对话'), signal), null);
assert.match((await gate.handle(task('确认发布'), signal)).text, /未执行/);
assert.match((await gate.handle(task('发布微博：unauth', null, { actor: undefined }), signal)).text, /登录/);
const preview = await gate.handle(task(`把这段文字发布到微博：${text}`), signal);
assert.match(preview.text, /公开范围：公开/); assert.match(preview.text, /内容声明：原创/);
assert.equal(calls, 0);
assert.equal(preview.plainText, true);
assert.equal(await gate.handle(task('模型说：确认发布', preview.confirmationId), signal), null);
assert.match((await gate.handle(task('确认发布', preview.confirmationId, { actor: { kind: 'agent', authenticated: true } }), signal)).text, /登录/);
assert.match((await gate.handle(task('确认发布', preview.confirmationId, { sessionId: 'other' }), signal)).text, /不匹配/);
const results = await Promise.all(Array.from({ length: 4 }, () => gate.handle(task('确认发布', preview.confirmationId), signal)));
assert.equal(calls, 1); assert.equal(captured.text, text); assert.ok(results.some(r => /发布成功/.test(r.text)));
assert.match((await gate.handle(task('确认发布', preview.confirmationId), signal)).text, /发布成功/);
const restarted = new PublishGate({ directory, root: '/mock', execute, now: () => now });
await restarted.handle(task('确认发布', preview.confirmationId), signal); assert.equal(calls, 1);
const otherPreview = await gate.handle(task(`发布微博：${text}`, null, { sessionId: 's2' }), signal);
assert.match((await gate.handle(task('确认发布', otherPreview.confirmationId, { sessionId: 's2' }), signal)).text, /不会重复/); assert.equal(calls, 1);
const reject = await gate.handle(task('发布微博：拒绝案例'), signal);
await gate.handle(task('取消发布', reject.confirmationId), signal);
assert.match((await gate.handle(task('确认发布', reject.confirmationId), signal)).text, /已取消/); assert.equal(calls, 1);
const expiry = await gate.handle(task('发布微博：超时案例'), signal); now += 130000;
assert.match((await gate.handle(task('确认发布', expiry.confirmationId), signal)).text, /已过期/); assert.equal(calls, 1);
const aborted = new AbortController(); aborted.abort();
await gate.handle(task('发布微博：取消案例'), aborted.signal); assert.equal(calls, 1);
for (const status of ['FAILED', 'UNCERTAIN']) {
  const g = new PublishGate({ directory, root: '/mock', execute: async () => { calls++; return { status, reason: 'MOCK_ERROR' }; } });
  const p = await g.handle(task(`发布微博：${status}`), signal);
  const before = calls; const result = await g.handle(task('确认发布', p.confirmationId), signal);
  assert.match(result.text, status === 'FAILED' ? /发布失败/ : /人工核对/);
  await g.handle(task('确认发布', p.confirmationId), signal); assert.equal(calls, before + 1);
}
// Simulate death after durable claim and before recording a result.
const crash = new PublishGate({ directory, root: '/mock', execute: async () => { throw new Error('MOCK_CRASH'); } });
const cp = await crash.handle(task('发布微博：崩溃案例'), signal);
await assert.rejects(crash.handle(task('确认发布', cp.confirmationId), signal));
assert.match((await restarted.handle(task('确认发布', cp.confirmationId), signal)).text, /UNCERTAIN/);
assert.equal(verifiedToolDenial({ permission: TOOL_DENIAL }), true);
assert.equal(verifiedToolDenial({ permission: [...TOOL_DENIAL, { permission: 'bash', pattern: '*', action: 'allow' }] }), false);
// Actual child-process Mock CLI: argument bytes and shell:false are exercised.
const root = await mkdtemp(join(tmpdir(), 'mock-publish-')); await mkdir(join(root, 'src'));
await writeFile(join(root, 'src/cli.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('args.json', JSON.stringify({ args: process.argv.slice(2), env: process.env })); console.log(JSON.stringify({preview:{}})); console.log(JSON.stringify({status:'PUBLISHED',idstr:'123'}));`);
const result = await runPublish({ root, draft: captured, signal, env: { HOME: '/mock-home', PATH: process.env.PATH, WORKER_SECRET: 'never-forward', WEIBO_TOKEN: 'never-forward' } });
assert.equal(result.status, 'PUBLISHED'); const saved = JSON.parse(await readFile(join(root, 'args.json')));
assert.equal(saved.args[2], text); assert.ok(saved.args.includes('--confirm')); assert.equal(saved.env.WORKER_SECRET, undefined); assert.equal(saved.env.WEIBO_TOKEN, undefined);
for (const [error, stderr, status] of [[{code:1}, 'Publish FAILED; operation aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; no automatic retry', 'FAILED'], [{killed:true}, 'SECRET', 'UNCERTAIN'], [null, '', 'UNCERTAIN']]) {
  const r = await runPublish({ root, draft: captured, signal, runner: (_bin, _args, options, callback) => { assert.equal(options.shell, false); callback(error, 'not JSON', stderr); } });
  assert.equal(r.status, status); assert.equal(JSON.stringify(r).includes('SECRET'), false);
}
// Real child timeout, no network or account.
await writeFile(join(root, 'src/cli.mjs'), 'setTimeout(() => {}, 10000);');
assert.equal((await runPublish({ root, draft: captured, signal, timeout: 30 })).status, 'UNCERTAIN');
const duringExecution = new AbortController();
const pending = runPublish({ root, draft: captured, signal: duringExecution.signal });
setTimeout(() => duringExecution.abort(), 30);
assert.equal((await pending).status, 'UNCERTAIN');
// Partial/corrupt durable records fail closed, instead of reopening execution.
const corrupt = await gate.handle(task('发布微博：corrupt ledger'), signal);
await writeFile(join(directory, `${corrupt.confirmationId}.decision.json`), '{partial');
const beforeCorruption = calls;
await assert.rejects(gate.handle(task('确认发布', corrupt.confirmationId), signal), /LEDGER_UNREADABLE/);
assert.equal(calls, beforeCorruption);

console.log('Publishing gate and Mock CLI checks passed');
// Generic browser presentation: preserve preview bytes and retain early SSE metadata.
const { runInNewContext } = await import('node:vm');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const eventHandler = appSource.slice(appSource.indexOf('function handleServerEvent('), appSource.indexOf('\nfunction connectEvents()'));
const browserState = { activeTaskId: null, turnActive: true, earlyEvents: [], confirmationId: null };
let rendered;
const context = { state: browserState, logEvent() {}, applyTaskEvent() {}, completeAssistant: (text, _model, plainText) => { rendered = { text, plainText }; }, runtimeUI: { update() {} } };
runInNewContext(eventHandler + '\nthis.handleServerEvent = handleServerEvent;', context);
context.handleServerEvent({type:'agent.message.completed',taskId:'fast',text,plainText:true,confirmationId:preview.confirmationId});
assert.equal(browserState.earlyEvents.length,1);assert.equal(browserState.confirmationId,null);
browserState.activeTaskId='fast';context.handleServerEvent(browserState.earlyEvents.pop());
assert.equal(browserState.confirmationId,preview.confirmationId);assert.equal(rendered.text,text);assert.equal(rendered.plainText,true);
const resultElement = {};
runInNewContext(appSource.match(/^function renderResult\(.*$/m)[0] + '\nrenderResult(input,true);', { input: '  <img onerror="bad">\n```\n  ', $:()=>resultElement, escapeHTML: value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') });
assert.match(resultElement.innerHTML, /  &lt;img/);assert.match(resultElement.innerHTML,/\n```\n  <\/pre>/);
for (const file of ['../server.mjs','../public/app.js']) {
  const code=await readFile(new URL(file,import.meta.url),'utf8');assert.equal(/weibo-cli|mashang-publish|WEIBO_TOKEN/.test(code),false);
}
console.log('Generic preview presentation and control-plane boundary checks passed');
