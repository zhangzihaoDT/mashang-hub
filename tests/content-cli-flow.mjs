import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Real CLI -> real Hub -> real Worker -> Content API; only model/network effects are mocked by the parent fixture.
export async function verifyContentCLI({ base, temp, entries, api, until, browser }) {
  let stateDir = '', cli, output = '', previous = 0;
  function start(target, state) {
    stateDir = join(temp, state); output = ''; previous = 0;
    cli = spawn(process.execPath, ['worker/mashang.mjs', 'content', target, '--hub', base], {
      env:{ ...process.env, HUB_ACCESS_TOKEN:'synthetic-login', MASHANG_CLI_STATE_DIR:stateDir }, stdio:['pipe','pipe','pipe'],
    });
    cli.stdout.on('data', data => { output += data; }); cli.stderr.on('data', data => { output += data; });
  }
  async function waitText(text) {
    try { await until(() => output.slice(previous).includes(text)); }
    catch { throw Error(`CLI output did not include ${JSON.stringify(text)}:\n${output.slice(previous) || output}`); }
    previous = output.length;
  }
  const input = text => cli.stdin.write(text + '\n');
  async function stop() {
    if (cli?.exitCode === null) { const exited = once(cli, 'exit'); input('/exit'); await exited; assert.equal(cli.exitCode, 0, output); }
  }
  async function profile() {
    const [name] = await readdir(stateDir);
    return { name, data: JSON.parse(await readFile(join(stateDir, name), 'utf8')) };
  }
  const markdown = async () => (await readdir(entries)).filter(file => file.endsWith('.md'));
  const tasksFor = async sessionId => (await api('/api/tasks')).data.filter(task => task.conversationId === sessionId && task.source === 'conversation');
  let page;
  try {
    const before = (await markdown()).length;
    start('notes', 'cli-notes'); await waitText('回车即整理并保存');
    const profileFile = await profile();
    const sessionId = profileFile.data.sessionId;
    assert.equal((await stat(join(stateDir, profileFile.name))).mode & 0o777, 0o600);
    assert.ok(profileFile.data.cookie); assert.ok(!JSON.stringify(profileFile.data).includes('synthetic-login'));
    assert.ok(profileFile.data.model?.providerID && profileFile.data.model?.modelID, 'CLI selects the Hub default model');
    assert.doesNotMatch(output, /\/status|\/web|\/retry|\/cancel|\/new|\/model|\/help/);

    input('讨论一个合成方案'); await waitText('已保存到本地');
    assert.match(output, /标题：合成笔记/);
    assert.doesNotMatch(output, /task_|RUNNING|COMPLETED/);
    assert.equal((await markdown()).length, before + 1, 'one submission saves exactly one note');
    const saved = (await tasksFor(sessionId))[0];
    assert.equal(saved.status, 'COMPLETED'); assert.equal(saved.workspaceId, 'publish');
    assert.equal(saved.model, `${profileFile.data.model.providerID}/${profileFile.data.model.modelID}`, 'no hidden OpenCode default');
    const result = (await api(`/api/tasks/${saved.taskId}/result`)).data;
    assert.equal(result.contentCard.notice, '已保存到本地');
    assert.match(result.text, /合成笔记/);
    assert.equal((await fetch(`${base}/api/tasks/${saved.taskId}/result`)).status, 401);
    assert.equal((await api('/api/tasks/nonexistent/result')).status, 404);

    if (browser) {
      page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/?workspace=publish&conversation=${sessionId}`);
      await page.locator('#accessToken').fill('synthetic-login'); await page.locator('#loginForm button').click();
      await page.getByText('已保存到本地', { exact:true }).last().waitFor();
      assert.equal(await page.locator('#workspaceTitle').textContent(), 'Content');
      assert.equal(await page.evaluate(() => localStorage.getItem('mashang-hub-publish-session')), sessionId);
      assert.match(await page.locator('#resultContent').textContent(), /合成笔记/);
      await page.locator('#prompt').fill('保留浏览器草稿');
      // A CLI record becomes visible in an already-open Web conversation.
      input('CLI追加合成笔记'); await waitText('已保存到本地');
      const nextTask = await until(async () => {
        const task = (await tasksFor(sessionId)).find(item => item.taskId !== saved.taskId && item.status === 'COMPLETED');
        return task || null;
      });
      const next = (await api(`/api/tasks/${nextTask.taskId}/result`)).data;
      await until(async () => (await page.locator('#resultContent').textContent()).includes(next.contentCard.title));
      assert.equal(await page.locator('#prompt').inputValue(), '保留浏览器草稿');
      // The same Hub/Worker workflow still serves the Web save.
      await page.locator('#prompt').fill('浏览器追加合成笔记'); await page.locator('#saveNote').click();
      await until(async () => (await tasksFor(sessionId)).some(item => item.taskId !== nextTask.taskId && item.status === 'COMPLETED'));
      assert.deepEqual(errors, []);
    }
    await stop();
    const tasksBeforeRestart = (await tasksFor(sessionId)).length;

    start('notes', 'cli-notes'); await waitText('回车即整理并保存');
    const reopened = await profile();
    assert.equal(reopened.data.sessionId, sessionId, 'restart attaches to the same Hub conversation');
    assert.equal((await tasksFor(sessionId)).length, tasksBeforeRestart, 'reopening never replays a prompt');
    assert.doesNotMatch(output, /task_|RUNNING|COMPLETED/);

    // Closing a client after dispatch leaves the server-owned task alive; restart reports it once.
    const known = new Set((await tasksFor(sessionId)).map(task => task.taskId));
    input('中断合成：仅退出客户端'); await waitText('正在整理并保存'); await stop();
    const detached = await until(async () => {
      const task = (await tasksFor(sessionId)).find(item => item.status === 'COMPLETED' && !known.has(item.taskId));
      return task || null;
    });
    assert.equal((await api(`/api/tasks/${detached.taskId}/result`)).data.contentCard.notice, '已保存到本地');
    start('notes', 'cli-notes'); await waitText('已保存到本地');
    assert.match(output, /标题：合成笔记/);
    await stop();

    start('notes', 'cli-notes'); await waitText('回车即整理并保存');
    input('/paste'); await waitText('多行输入'); input('第一行'); input('第二行'); input('/end'); await waitText('已保存到本地');
    const tasksBeforeRetired = (await tasksFor(sessionId)).length;
    input('/status'); await waitText('直接输入内容即可');
    assert.equal((await tasksFor(sessionId)).length, tasksBeforeRetired, 'removed commands are never saved or executed');
    await stop();

    // Flomo: one submission organizes, previews, is scoped-approved, and waits for the API confirmation.
    const beforeFlomo = (await markdown()).length;
    start('flomo', 'cli-flomo'); await waitText('回车即整理并同步到 Flomo');
    const flomoProfile = await profile();
    const flomoSession = flomoProfile.data.sessionId;
    assert.doesNotMatch(output, /\/status|\/web|\/retry|\/cancel|\/new|\/model|\/help/);
    input('CLI 直接同步合成内容 #测试'); await waitText('已同步到 Flomo');
    assert.match(output, /标题：合成笔记/);
    assert.doesNotMatch(output, /task_|RUNNING|COMPLETED|control_/);
    const flomoTask = (await tasksFor(flomoSession))[0];
    assert.equal(flomoTask.status, 'COMPLETED'); assert.equal(flomoTask.workspaceId, 'publish');
    const flomoControl = await until(async () => {
      const control = (await api('/api/runtime/controls')).data.filter(item => item.originTaskId === flomoTask.taskId).sort((a, b) => b.createdAt - a.createdAt)[0];
      return control?.status === 'COMPLETED' && control;
    });
    assert.equal(flomoControl.targetId, 'notes-flomo');
    assert.equal((await markdown()).length, beforeFlomo, 'Flomo sync does not pretend to save a local note');
    // An unconfirmed external send is never retried automatically; Enter only rechecks.
    input('超时合成 #测试'); await waitText('结果待确认');
    assert.match(output, /未同步/);
    const tasksBeforeRecheck = (await tasksFor(flomoSession)).length;
    input(''); await waitText('结果待确认');
    assert.equal((await tasksFor(flomoSession)).length, tasksBeforeRecheck, 'Enter rechecks without resubmitting');
    await stop();
    console.log(`Content CLI integration: automatic local save, scoped Flomo sync, private profile, restart, detach, native retry/recheck and multiline submit${browser ? ', shared Web conversation' : ''} passed`);
  } finally { await page?.close(); if (cli?.exitCode === null) { const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await exited; } }
}
