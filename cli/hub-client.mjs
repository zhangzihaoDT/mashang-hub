import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function hubURL(value) {
  const url = new URL(value);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Error('Hub 地址须为不含凭证、路径或查询参数的 HTTP(S) 地址。');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw Error('远程 Hub 必须使用 HTTPS。');
  return url.origin;
}

export class HubClient {
  constructor(base, { stateDir = join(homedir(), '.mashang', 'clients'), token = '', signal } = {}) {
    this.base = hubURL(base); this.token = token; this.signal = signal; this.profile = {};
    this.stateDir = stateDir;
    this.profilePath = join(stateDir, `${createHash('sha256').update(this.base).digest('hex')}.json`);
  }
  async load() {
    try { this.profile = JSON.parse(await readFile(this.profilePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('无法读取 CLI 会话配置，请检查配置文件。'); }
  }
  async save() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.profilePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.profile), { mode: 0o600 });
    await rename(temporary, this.profilePath);
  }
  async request(path, body) {
    const response = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', ...(this.profile.cookie ? { cookie: this.profile.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || `HTTP ${response.status}`), { status: response.status, data: value });
    return { value, response };
  }
  async api(path, body) { return (await this.request(path, body)).value; }
  async openEvents(onEvent) {
    // Keep the never-ending SSE response out of fetch's ordinary request pool.
    // A shared connection can leave subsequent POSTs queued behind the stream.
    const response = await new Promise((resolve, reject) => {
      const request = (this.base.startsWith('https:') ? httpsRequest : httpRequest)(this.base + '/api/events', {
        agent:false, signal:this.signal, headers:{ cookie:this.profile.cookie || '', accept:'text/event-stream' },
      }, response => { clearTimeout(timeout); resolve(response); });
      const timeout = setTimeout(() => request.destroy(Error('事件连接超时')), 15000);
      request.once('error', error => { clearTimeout(timeout); reject(error); });
      request.end();
    });
    if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/event-stream')) {
      response.destroy();
      throw Object.assign(Error(`事件连接失败：HTTP ${response.statusCode}`), { status:response.statusCode });
    }
    response.setEncoding('utf8');
    const done = (async () => {
      let buffer = '';
      for await (const chunk of response) {
        buffer += chunk;
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) { try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed events. */ } }
        }
        if (buffer.length > 2000000) throw Error('事件长度超过限制');
      }
    })();
    return { done };
  }
  async authenticate(askToken) {
    const auth = await this.api('/api/auth/status');
    if (!auth.required) throw Error('Content 笔记需要用户登录，请在 Hub 配置 HUB_ACCESS_TOKEN。');
    if (auth.authenticated) return;
    const token = this.token || await askToken();
    if (!token) throw Error('缺少 Hub 用户访问令牌。');
    const { response } = await this.request('/api/auth/login', { token });
    this.profile.cookie = response.headers.get('set-cookie')?.split(';')[0];
    await this.save();
  }
  async selectSession(id, fresh = false) {
    const sessions = await this.api('/api/sessions');
    const requested = id || (!fresh && this.profile.sessionId);
    let session = requested && sessions.find(item => item.id === requested);
    if (requested && !session) throw Error('会话不存在；请检查 Hub 地址，或使用 --new 新建。');
    if (id) {
      const tasks = (await this.api('/api/tasks')).filter(task => task.conversationId === id);
      if (tasks.some(task => task.source === 'conversation' && task.workspaceId !== 'publish'))
        throw Error('请选择 Content 会话；此入口不接管其他板块的会话。');
    }
    if (!session) session = await this.api('/api/sessions', { title: 'mashang-hub' });
    this.profile.sessionId = session.id; await this.save(); return session;
  }
  async tasks() {
    return (await this.api('/api/tasks')).filter(task => task.source === 'conversation' &&
      task.conversationId === this.profile.sessionId && task.workspaceId === 'publish');
  }
  async submit(text, action = null, { scopedAuthorization = null } = {}) {
    return this.api(`/api/sessions/${encodeURIComponent(this.profile.sessionId)}/message`, {
      workspaceId: 'publish', model: this.profile.model || null, parts: [{ type: 'text', text }], contentAction: action,
      ...(scopedAuthorization ? { scopedAuthorization } : {}),
    });
  }
  webLink() {
    const url = new URL(this.base);
    url.searchParams.set('workspace', 'publish'); url.searchParams.set('conversation', this.profile.sessionId);
    return url.href;
  }
}
