import { createInterface, clearLine, cursorTo } from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { HubClient } from './hub-client.mjs';
import { selectAvailableModel } from '../public/model-selection.js';
import { snapshotDigest } from '../server/operation-proof.mjs';

export const TARGETS = Object.freeze({
  notes: { id: 'notes', success: '已保存到本地', prompt: 'notes › ' },
  flomo: { id: 'flomo', success: '已同步到 Flomo', prompt: 'flomo › ' },
});

export const HELP = `用法：
  mashang content notes [--hub URL]
  mashang content flomo [--hub URL]

直接输入内容，回车即整理并保存/同步。
多行可直接粘贴，按 Enter 提交。Ctrl+C 退出。

环境：HUB_URL、HUB_ACCESS_TOKEN、MASHANG_CLI_STATE_DIR`;

// Provider text must not be able to inject terminal control sequences.
export function terminalText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

// Every message ends with exactly one newline. A block (a finished record) adds
// one empty line before the next prompt; trailing newlines are normalized so
// consecutive blocks can never accumulate blank lines.
export function terminalMessage(value, { block = false } = {}) {
  return terminalText(value).replace(/\n+$/, '') + (block ? '\n\n' : '\n');
}

export function parseContentArgs(args) {
  const result = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--hub' && args[i + 1] && !args[i + 1].startsWith('--')) result.hub = args[++i];
    else if (arg.startsWith('-')) throw Error(`未知或缺少参数：${arg}`);
    else result.positional.push(arg);
  }
  if (result.positional.length > 1) throw Error(`未知参数：${result.positional[1]}。`);
  result.target = result.positional[0] || null;
  if (result.target && !TARGETS[result.target]) throw Error(`未知记录目标：${result.target}。请使用 notes 或 flomo。`);
  return result;
}

export function noteTitle(result, original = '') {
  const card = result?.contentCard;
  if (card?.title) return card.title;
  const first = String(result?.text || original).split('\n')[0].trim();
  return first.replace(/^\*\*|\*\*$/g, '').trim().slice(0, 120) || '未命名笔记';
}

// Result details sit one level under the status line so each record reads as a
// single block. A card title may contain line breaks; they must not escape the
// block or push the next prompt out of alignment.
const DETAIL = '  ';
export function successLine(entry, result) {
  const lines = [`✓ ${(TARGETS[entry.target] || TARGETS.notes).success}`];
  if (result?.contentCard?.title || result?.text || entry.text) lines.push(`${DETAIL}标题：${noteTitle(result, entry.text).replace(/[\r\n]+/g, ' ')}`);
  if (entry.target === 'notes') lines.push(`${DETAIL}位置：本地 Notes 库`);
  return lines.join('\n');
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function appendPending(existing, prefix, text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const full = prefix ? (normalized ? `${prefix}\n${normalized}` : prefix) : normalized;
  if (!full.trim()) return existing;
  return existing ? `${existing}\n${full}` : full;
}

// Bracketed paste gives exact boundaries even when the terminal splits the
// paste across data chunks. Text outside a paste is passed through untouched.
export function createPasteParser({ onStart = () => {}, onData = () => {}, onPaste = () => {} } = {}) {
  let inPaste = false, buffer = '', held = '';
  const partialMarker = text => {
    for (let size = Math.min(PASTE_START.length - 1, text.length); size > 0; size--)
      if (text.endsWith(PASTE_START.slice(0, size))) return size;
    return 0;
  };
  return {
    write(chunk) {
      let text = held + String(chunk); held = '';
      while (text) {
        if (inPaste) {
          const end = text.indexOf(PASTE_END);
          if (end < 0) { buffer += text; return; }
          buffer += text.slice(0, end);
          text = text.slice(end + PASTE_END.length);
          inPaste = false;
          const paste = buffer; buffer = '';
          onPaste(paste);
          // Some terminals add a line break after the paste boundary. It is
          // not a user Enter and must not submit the pending composition.
          if (text.startsWith('\r\n')) text = text.slice(2);
          else if (text.startsWith('\r') || text.startsWith('\n')) text = text.slice(1);
          continue;
        }
        const start = text.indexOf(PASTE_START);
        if (start < 0) {
          const size = partialMarker(text);
          if (size) { held = text.slice(-size); text = text.slice(0, -size); }
          if (text) onData(text);
          return;
        }
        if (start > 0) onData(text.slice(0, start));
        text = text.slice(start + PASTE_START.length);
        inPaste = true;
        onStart();
      }
    },
  };
}

async function secretPrompt() {
  if (!process.stdin.isTTY) throw Error('非交互输入请通过 HUB_ACCESS_TOKEN 提供用户令牌。');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise((resolve, reject) => {
      input.on('SIGINT', () => reject(Error('已取消登录。')));
      input.on('close', () => reject(Error('已关闭登录输入。')));
      input.question('Hub 用户令牌（隐藏输入）：', resolve); muted = true;
    });
  } finally { input.close(); process.stdout.write('\n'); }
}

const settled = task => ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'UNCERTAIN', 'UNKNOWN', 'INTERRUPTED'].includes(task?.legacyStatus || task?.status);
const taskState = task => task?.legacyStatus || task?.status || 'UNKNOWN';
const uncertainState = task => ['UNCERTAIN', 'UNKNOWN', 'INTERRUPTED'].includes(taskState(task)) || task?.reason === 'EXTERNAL_RESULT_UNVERIFIED';
const controlSettled = control => ['COMPLETED', 'FAILED', 'REFUSED', 'REJECTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN', 'UNCERTAIN', 'INTERRUPTED'].includes(control?.status);
const controlUncertain = control => ['UNKNOWN', 'UNCERTAIN', 'INTERRUPTED', 'PENDING_APPROVAL'].includes(control?.status);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Old commands are not executed; they only get a short migration hint instead
// of being saved as note content by accident.
const RETIRED_COMMANDS = new Set(['/status', '/retry', '/cancel', '/web', '/new', '/model', '/models', '/help', '/sessions', '/resume', '/discard', '/quit', '/paste', '/end']);

function taskFailureReason(task, reported) {
  if (reported) return reported;
  if (task?.error) return task.error;
  const state = taskState(task);
  if (state === 'CANCELLED') return '记录已取消。';
  if (state === 'TIMEOUT') return '处理超时，未确认完成。';
  if (state === 'UNCERTAIN') return '保存结果待确认，请先核对，避免重复写入。';
  if (state === 'UNKNOWN' || state === 'INTERRUPTED') return '执行结果待确认，请先核对。';
  if (task?.reason === 'EMPTY_RESULT') return '没有生成可保存的内容。';
  if (task?.reason === 'OPENCODE_ERROR') return '整理或保存失败。';
  return '整理或保存失败。';
}

const CONTROL_REASONS = {
  EXEC_ERROR: 'Flomo 同步执行失败，未确认接收。',
  CONTENT_CHANGED: '笔记内容已变化，未同步。',
  WORKER_OFFLINE: '服务暂时不可用，Flomo 未同步。',
  SNAPSHOT_UNAVAILABLE: '笔记内容暂时不可用，Flomo 未同步。',
  INVALID_APPROVAL: '同步授权已失效，Flomo 未同步。',
  CANCELLATION_UNSUPPORTED: '同步已开始，无法取消；结果待确认。',
};

function controlFailureReason(control) {
  if (!control) return '未能启动同步任务，Flomo 未确认接收。';
  if (control.status === 'PENDING_APPROVAL') return '同步等待确认，Flomo 尚未接收。请在 Web 会话中确认。';
  if (control.status === 'FAILED') return CONTROL_REASONS[control.code] || (control.code ? `Flomo 同步失败（${control.code}），未确认接收。` : 'Flomo 同步失败，未确认接收。');
  if (control.status === 'CANCELLED' || control.status === 'REJECTED') return '同步已取消，Flomo 未接收。';
  if (controlUncertain(control)) return 'Flomo 接收结果待确认，请先核对，避免重复发布。';
  return CONTROL_REASONS[control.reason] || control.reason || `同步未完成（${control.status}）。`;
}

function friendlyError(error) {
  if (error.status === 401) return '登录已过期；请退出并重新进入。';
  if (error.status === 409) return '上一笔仍在整理，请稍后再试。';
  if (error.status === 503) return '服务暂时不可用，请稍后重试。';
  return error.message;
}

export async function runContent(args, env = process.env) {
  const opts = parseContentArgs(args);
  if (opts.help || !opts.target) { process.stdout.write(HELP + '\n'); return; }
  const target = TARGETS[opts.target];
  const abort = new AbortController();
  const client = new HubClient(opts.hub || env.HUB_URL || 'http://127.0.0.1:3000', {
    stateDir: env.MASHANG_CLI_STATE_DIR, token: env.HUB_ACCESS_TOKEN, signal: abort.signal,
  });
  await client.load(); await client.authenticate(secretPrompt);
  const models = (await client.api('/api/models')).models || [];
  const model = selectAvailableModel(models);
  if (!model) throw Error('Hub 暂无可用模型，请联系管理员检查 Worker 连接。');
  client.profile.model = { providerID: model.providerID, modelID: model.modelID };
  await client.save().catch(() => {});
  await client.selectSession();

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let rl, closed = false, active = null, pendingPaste = null, pastePrefix = '';
  let pendingLabels = [], ignoreEmptyUntil = 0;
  let retry = null, commandQueue = Promise.resolve(), eventsReady = false, resultEndpointMissing = false;
  const liveResults = new Map(), terminalErrors = new Map();
  function renderPrompt() {
    if (!tty || !rl || rl.closed) return;
    const labels = pendingPaste !== null ? pendingLabels.join('') : '';
    rl.setPrompt(labels ? `${target.prompt}${labels} ` : target.prompt);
    rl.prompt(true);
  }
  const say = (value, options) => {
    if (closed) return;
    if (tty && rl) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); }
    process.stdout.write(terminalMessage(value, options));
    renderPrompt();
  };
  async function readResult(task) {
    if (liveResults.has(task.taskId)) return liveResults.get(task.taskId);
    if (!resultEndpointMissing) {
      try { return await client.api(`/api/tasks/${encodeURIComponent(task.taskId)}/result`); }
      catch (error) { if (error.status !== 404) throw error; resultEndpointMissing = true; }
    }
    if (task.resultPreview) return client.api(`/api/tasks/${encodeURIComponent(task.taskId)}/preview`);
    return null;
  }
  async function connectEvents() {
    const stream = await client.openEvents(event => {
      if (event.sessionId !== client.profile.sessionId) return;
      if (event.type === 'agent.message.completed') {
        liveResults.set(event.taskId, { text: event.text || '', contentCard: event.contentCard || null, plainText: event.plainText === true });
        if (liveResults.size > 30) liveResults.delete(liveResults.keys().next().value);
      }
      if (['task.failed', 'task.cancelled', 'task.interrupted', 'task.timeout'].includes(event.type) && event.error)
        terminalErrors.set(event.taskId, event.error);
    });
    eventsReady = true;
    stream.done.catch(() => {}).finally(() => {
      eventsReady = false;
      if (!closed) { say('连接暂时中断，正在恢复…'); reconnectEvents(); }
    });
  }
  function reconnectEvents() {
    const timer = setTimeout(() => { if (!closed) connectEvents().catch(() => { if (!closed) reconnectEvents(); }); }, 1500);
    timer.unref();
  }
  async function latestTask() {
    const tasks = await client.tasks();
    return tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
  }
  async function getTask(taskId) {
    try { return await client.api(`/api/tasks/${encodeURIComponent(taskId)}`); }
    catch { return null; }
  }
  async function markReported(taskId) {
    if (client.profile.lastReportedTaskId === taskId) return;
    client.profile.lastReportedTaskId = taskId;
    await client.save().catch(() => {});
  }
  async function controlsFor(taskId) {
    const controls = await client.api('/api/runtime/controls');
    return controls.filter(item => item.originTaskId === taskId && item.targetId === 'notes-flomo').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  async function waitForTask(taskId) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let task = null;
    while (!closed) {
      task = await getTask(taskId);
      if (task && settled(task)) return task;
      if (Date.now() > deadline) return task;
      await delay(600);
    }
    return task;
  }
  async function waitForControl(taskId) {
    const deadline = Date.now() + 2 * 60 * 1000, missingSince = Date.now();
    let control = null, pendingSince = 0;
    while (!closed) {
      [control] = await controlsFor(taskId);
      if (!control && Date.now() - missingSince > 8000) return null;
      if (control?.status === 'PENDING_APPROVAL') {
        pendingSince ||= Date.now();
        if (Date.now() - pendingSince > 8000) return control;
      } else pendingSince = 0;
      if (controlSettled(control)) return control;
      if (Date.now() > deadline) return control;
      await delay(700);
    }
    return control;
  }
  function reportFailure(entry, reason, uncertain = false) {
    if (closed) return;
    const prefix = entry.target === 'notes' ? '未保存' : '未同步';
    retry = uncertain || !entry.text
      ? { kind: 'check', taskId: entry.taskId, target: entry.target, text: entry.text || '' }
      : { kind: 'text', text: entry.text, target: entry.target };
    const next = uncertain || !entry.text ? '按 Enter 重新检查；或直接输入新内容。' : '按 Enter 重试；或直接输入新内容。';
    say(`✗ ${prefix}：${reason}\n${DETAIL}${next}`, { block: true });
  }
  async function reportOutcome(entry, task) {
    if (!settled(task)) {
      retry = { kind: 'check', taskId: entry.taskId, target: entry.target, text: entry.text || '' };
      say(`仍在整理这一条…\n${DETAIL}完成后按 Enter 查看结果。`, { block: true });
      return;
    }
    const result = await readResult(task);
    if (taskState(task) === 'COMPLETED') {
      if (entry.target === 'flomo') {
        const control = await waitForControl(entry.taskId);
        if (control?.status === 'COMPLETED') {
          retry = null;
          say(successLine(entry, result), { block: true });
          await markReported(entry.taskId);
          return;
        }
        reportFailure(entry, controlFailureReason(control), controlUncertain(control));
        return;
      }
      if (result?.contentCard?.notice) {
        retry = null;
        say(successLine(entry, result), { block: true });
        await markReported(entry.taskId);
        return;
      }
      if (result?.contentCard) {
        reportFailure(entry, '笔记已整理，但未确认写入本地。', true);
        return;
      }
      reportFailure(entry, '没有收到可确认的笔记保存结果。', true);
      return;
    }
    reportFailure(entry, taskFailureReason(task, terminalErrors.get(entry.taskId)), uncertainState(task));
  }
  async function watch(entry) {
    try {
      const task = await waitForTask(entry.taskId);
      if (!task || closed) return;
      await reportOutcome(entry, task);
    } catch (error) {
      if (!closed) reportFailure(entry, `暂时无法确认：${error.message}。`, true);
    } finally {
      if (active === entry) active = null;
      if (!closed) renderPrompt();
    }
  }
  async function recheck(entry) {
    if (!entry.taskId) { retry = null; say('请直接输入内容。'); return; }
    const task = await getTask(entry.taskId);
    if (!task) {
      retry = entry;
      say('暂时无法读取上次结果；请稍后再按 Enter。', { block: true });
      return;
    }
    await reportOutcome(entry, task);
  }
  async function submitContent(text) {
    if (!text.trim()) return;
    if (active) { say('上一笔仍在整理，请稍后再输入。'); return; }
    if (!eventsReady) {
      retry = { kind: 'text', text, target: target.id };
      say('连接正在恢复；内容已保留，稍后按 Enter 提交。', { block: true });
      return;
    }
    const existing = await latestTask().catch(() => undefined);
    if (existing === undefined) {
      retry = { kind: 'text', text, target: target.id };
      say('暂时无法连接；内容已保留，按 Enter 重试。', { block: true });
      return;
    }
    if (existing && !settled(existing)) {
      retry = { kind: 'text', text, target: target.id };
      say('上一笔仍在整理；这段内容已保留，稍后按 Enter 提交。', { block: true });
      return;
    }
    retry = null;
    const entry = { text, target: target.id, taskId: null };
    const startedAt = Date.now();
    say(target.id === 'notes' ? '正在整理并保存…' : '正在整理并同步…');
    let task;
    try {
      if (target.id === 'flomo') {
        const scopedAuthorization = { targetId: 'notes-flomo', sourceDigest: snapshotDigest(text) };
        task = await client.submit(`直接同步到 Flomo：${text}`, null, { scopedAuthorization });
      } else task = await client.submit(text, { action: 'save-input' });
    } catch (error) {
      if (!error.status || error.status >= 500) {
        const candidate = await latestTask().catch(() => null);
        const adopted = candidate?.createdAt >= startedAt - 2000 ? candidate : null;
        if (adopted) {
          entry.taskId = adopted.taskId; active = entry;
          client.profile.lastTaskId = adopted.taskId; client.profile.lastTarget = target.id;
          await client.save().catch(() => {});
          say('提交响应中断，已接续本次记录；不会重发。');
          void watch(entry);
          return;
        }
        retry = { kind: 'text', text, target: target.id };
        say('提交结果待确认；按 Enter 重试，或直接输入新内容。', { block: true });
        return;
      }
      if (error.status === 409 || error.status === 503) {
        retry = { kind: 'text', text, target: target.id };
        say(`${friendlyError(error)}\n${DETAIL}内容已保留，按 Enter 重试。`, { block: true });
        return;
      }
      throw error;
    }
    entry.taskId = task.taskId; active = entry;
    client.profile.lastTaskId = task.taskId; client.profile.lastTarget = target.id;
    await client.save().catch(() => {});
    void watch(entry);
  }
  async function emptyLine() {
    if (active || !retry) return;
    const current = retry;
    if (current.kind === 'text') { retry = null; await submitContent(current.text); }
    else await recheck(current);
  }

  const intro = target.id === 'notes'
    ? 'Content · Notes\n直接输入内容，回车即整理并保存。'
    : 'Content · Flomo\n直接输入内容，回车即整理并同步到 Flomo。';
  async function processLine(line) {
    if (pendingPaste !== null) {
      if (line.trim() === '/exit') { rl.close(); return; }
      // Some terminals emit a line break between bracketed paste chunks.
      // Ignore that boundary newline, but keep a later deliberate Enter.
      if (!line.trim() && Date.now() < ignoreEmptyUntil) { ignoreEmptyUntil = 0; return; }
      ignoreEmptyUntil = 0;
      if (active) { say('上一笔仍在整理；粘贴内容已保留，完成后按 Enter 提交。', { block: true }); return; }
      const pasted = pendingPaste; pendingPaste = null; pendingLabels = [];
      resetPrompt();
      await submitContent(line.trim() ? `${pasted}\n${line}` : pasted);
      return;
    }
    if (line.trim() === '/exit') { rl.close(); return; }
    if (!line.trim()) { await emptyLine(); return; }
    if (RETIRED_COMMANDS.has(line.trim())) { say('直接输入或粘贴内容，按 Enter 提交。'); return; }
    await submitContent(line);
  }
  function enqueueLine(line) {
    commandQueue = commandQueue.then(async () => {
      if (closed) return;
      try { await processLine(line); }
      catch (error) { say(friendlyError(error)); }
      finally { if (!closed) renderPrompt(); }
    });
  }
  function pasteMarker(text) {
    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
    return `[pasted~${lines}${lines === 1 ? 'line' : 'lines'}]`;
  }
  const updatePastePrompt = renderPrompt;
  const resetPrompt = renderPrompt;
  function finishPaste(text) {
    const prefix = pastePrefix; pastePrefix = '';
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const combined = appendPending(pendingPaste, prefix, text);
    if (combined === pendingPaste) return;
    if (prefix) pendingLabels.push(terminalText(prefix));
    if (normalized.trim()) pendingLabels.push(pasteMarker(normalized));
    pendingPaste = combined;
    ignoreEmptyUntil = Date.now() + 80;
    if (tty) updatePastePrompt();
    else say(pasteMarker(pendingPaste));
  }
  process.stdin.setEncoding('utf8');
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty, prompt: target.prompt, historySize: 100 });
  // Bracketed paste boundaries let the entire paste arrive as one block, while
  // normal typing and readline editing keep working unchanged. Parsing sits in
  // front of readline so piped input follows the same composition rules.
  const originalEmit = process.stdin.emit;
  const parser = createPasteParser({
    onStart() {
      pastePrefix = tty ? (rl?.line || '') : '';
      if (pastePrefix) rl.write(null, { ctrl: true, name: 'u' });
    },
    onData(text) { originalEmit.call(process.stdin, 'data', text); },
    onPaste(text) { finishPaste(text); },
  });
  process.stdin.emit = function (event, ...args) {
    if (event !== 'data') return originalEmit.apply(this, [event, ...args]);
    parser.write(args[0]);
    return true;
  };
  const cleanupPaste = () => {
    process.stdin.emit = originalEmit;
    if (tty) process.stdout.write('\x1b[?2004l');
  };
  if (tty) {
    process.stdout.write('\x1b[?2004h');
    process.once('exit', () => process.stdout.write('\x1b[?2004l'));
  }
  rl.on('line', line => enqueueLine(line));

  try { await connectEvents(); }
  catch (error) { cleanupPaste(); rl.close(); throw error; }
  say(`${intro}\n多行可直接粘贴，按 Enter 提交。Ctrl+C 退出。`, { block: true });

  const previousTaskId = client.profile.lastTaskId;
  if (previousTaskId && client.profile.lastReportedTaskId !== previousTaskId) {
    try {
      const task = await getTask(previousTaskId);
      if (task && task.conversationId === client.profile.sessionId) {
        const previousTarget = TARGETS[client.profile.lastTarget] || target;
        active = { text: '', target: previousTarget.id, taskId: previousTaskId };
        if (!settled(task)) say('正在整理上一段内容…');
        void watch(active);
      }
    } catch { /* The next submission still works; recovery is best effort. */ }
  }
  const stop = () => { cleanupPaste(); rl.close(); };
  rl.on('SIGINT', stop); process.on('SIGTERM', stop);
  renderPrompt();
  await new Promise(resolve => rl.once('close', resolve));
  closed = true; cleanupPaste(); abort.abort(); process.removeListener('SIGTERM', stop);
  process.stdout.write('\n已退出；已提交的记录会继续整理。\n');
}
