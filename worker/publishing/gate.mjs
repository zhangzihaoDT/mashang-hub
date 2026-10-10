import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const TOOL_DENIAL = [{ permission: '*', pattern: '*', action: 'deny' }];
export function verifiedToolDenial(session) {
  const rules = session?.permission;
  return Array.isArray(rules) && rules.length === 1 && rules[0].permission === '*' && rules[0].pattern === '*' && rules[0].action === 'deny';
}
const hash = value => createHash('sha256').update(value).digest('hex');
const labels = { public: '公开（所有人可见）', private: '私密（仅自己可见）', original: '原创', ai: 'AI 生成', repost: '转载' };
export function parseIntent(prompt) {
  // Explicit, bounded syntax: prose outside this grammar is never executed.
  const match = /^(?:把这段文字发布到微博|发布微博|发微博)(?:\s*\[(public|private),(original|ai|repost)\])?[:：]([\s\S]+)$/.exec(prompt);
  if (!match) return null;
  const draft = { text: match[3], visibility: match[1] || 'public', statement: match[2] || 'original' };
  if (!draft.text.trim() || draft.text.startsWith('--') || Buffer.byteLength(draft.text) > 64 * 1024) throw new Error('INVALID_TEXT');
  return draft;
}
// CLI prints a preview JSON document followed by a result JSON document.
export function jsonDocuments(text) {
  const docs = []; let start = -1; let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (/\s/.test(c)) continue; if (c !== '{') throw new Error('INVALID_OUTPUT'); start = i; }
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (!depth) { docs.push(JSON.parse(text.slice(start, i + 1))); start = -1; } }
  }
  if (start !== -1 || !docs.length) throw new Error('INVALID_OUTPUT');
  return docs;
}
export function runPublish({ root, draft, signal, runner = execFile, timeout = 45000, env = process.env }) {
  return new Promise(resolve => {
    runner(process.execPath, [join(root, 'src/cli.mjs'), 'publish', '--text', draft.text, '--visibility', draft.visibility, '--statement', draft.statement, '--confirm'], {
      cwd: root, shell: false, encoding: 'utf8', timeout, signal, maxBuffer: 1024 * 1024,
      env: Object.fromEntries(['HOME', 'PATH', 'TMPDIR'].filter(key => env[key]).map(key => [key, env[key]])),
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = /Publish (FAILED|UNCERTAIN); operation ([a-f0-9-]{36}); no automatic retry/.exec(stderr || '');
        return resolve({ status: failure?.[1] || 'UNCERTAIN', operationId: failure?.[2] || null, reason: error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : error.killed ? 'TIMEOUT' : 'CLI_ERROR' });
      }
      try {
        const result = jsonDocuments(stdout).at(-1);
        if (result.status !== 'PUBLISHED' || !/^[1-9]\d{0,19}$/.test(result.idstr) || typeof result.idstr !== 'string') throw new Error();
        resolve({ status: 'PUBLISHED', idstr: result.idstr, url: `https://weibo.com/detail/${result.idstr}` });
      } catch { resolve({ status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }); }
    });
  });
}
async function immutable(file, value) {
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(join(file, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return true;
}
async function load(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('LEDGER_UNREADABLE'); }
}
export class PublishGate {
  constructor({ directory, root, execute = runPublish, now = Date.now, ttlMs = 120000 }) {
    Object.assign(this, { directory, root, execute, now, ttlMs });
  }
  async handle(task, signal, onDispatch = () => {}) {
    const prompt = String(task.prompt || '');
    const intent = parseIntent(prompt);
    const confirmation = /^确认发布(?:\s+([a-f0-9]{64}))?[。！!]?\s*$/.exec(prompt);
    const rejection = /^(?:取消发布|拒绝发布|取消|拒绝)[。！!]?\s*$/.test(prompt);
    if (!intent && !confirmation && !rejection && task.workspaceId !== 'publish') return null;
    if (task.actor?.kind !== 'user' || task.actor.authenticated !== true) return { text: '发布入口需要已登录的 Hub 用户；未执行发布。' };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (signal.aborted) return { text: '已取消；未执行发布。' };
    if (intent) {
      const id = hash(JSON.stringify([task.sessionId, intent]));
      const draftFile = join(this.directory, `${id}.draft.json`);
      await immutable(draftFile, { ...intent, id, sessionId: task.sessionId, expiresAt: this.now() + this.ttlMs });
      const draft = await load(draftFile);
      const decision = await load(join(this.directory, `${id}.decision.json`));
      if (decision) return this.result(id, decision);
      if (this.now() >= draft.expiresAt) return { text: '此草稿确认已过期；未执行发布。请修改正文后重新预览。' };
      return { confirmationId: id, plainText: true, text: `最终正文：\n\n${draft.text}\n\n公开范围：${labels[draft.visibility]}\n内容声明：${labels[draft.statement]}\n\n尚未发布。请在本窗口回复“确认发布”，或回复“取消发布”。确认有效期 ${Math.ceil(this.ttlMs / 1000)} 秒。页面刷新后请回复“确认发布 ${id}”。` };
    }
    const id = confirmation?.[1] || task.confirmationId;
    if (!/^[a-f0-9]{64}$/.test(id || '')) return { text: '没有绑定到预览的确认；未执行发布。请先提供正文并预览。' };
    const draft = await load(join(this.directory, `${id}.draft.json`));
    if (!draft || draft.sessionId !== task.sessionId) return { text: '确认与当前对话草稿不匹配；未执行发布。' };
    const decisionFile = join(this.directory, `${id}.decision.json`);
    const previous = await load(decisionFile);
    if (previous) return this.result(id, previous);
    if (rejection || signal.aborted || this.now() >= draft.expiresAt) {
      await immutable(decisionFile, { status: rejection || signal.aborted ? 'CANCELLED' : 'EXPIRED' });
      return this.result(id, await load(decisionFile));
    }
    if (!confirmation) return { text: '请回复“确认发布”或“取消发布”；未执行发布。', confirmationId: id };
    // One permanent exclusive claim per content, including across conversations.
    // A crash, timeout, cancellation or uncertain response can never reopen it.
    const contentKey = hash(JSON.stringify([draft.text, draft.visibility, draft.statement]));
    const claim = join(this.directory, `${contentKey}.claim.json`);
    if (!await immutable(decisionFile, { status: 'UNCERTAIN' })) return this.result(id, await load(decisionFile));
    if (!await immutable(claim, { status: 'UNCERTAIN', id })) return { text: '相同正文已有执行记录；不会重复发布。请人工核对微博。' };
    if (signal.aborted) return { text: '已取消；执行记录保持 UNCERTAIN，不会自动重试。' };
    onDispatch();
    const result = await this.execute({ root: this.root, draft, signal });
    await immutable(join(this.directory, `${id}.result.json`), result);
    return this.result(id, result);
  }
  async result(id, decision) {
    const result = await load(join(this.directory, `${id}.result.json`)) || decision;
    if (result.status === 'PUBLISHED') return { text: `发布成功（PUBLISHED）。\n微博 ID：${result.idstr}\n链接：${result.url}`, confirmationId: null };
    if (result.status === 'FAILED') return { text: `发布失败（${result.reason || 'CLI_ERROR'}）。不会自动重试。`, confirmationId: null };
    if (['CANCELLED', 'EXPIRED'].includes(result.status)) return { text: `确认${result.status === 'EXPIRED' ? '已过期' : '已取消'}；未执行发布。`, confirmationId: null };
    return { text: '发布结果不确定（UNCERTAIN）。请在微博人工核对；不会自动重试或重复发布。', confirmationId: null };
  }
}
