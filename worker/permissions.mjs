// Permission ownership is proven by the current user message and tool call, not
// by the shared session. Unknown and historical requests stay with OpenCode.
const identityMatches = (a, b) => a && b && ['taskId', 'attemptId', 'dispatchId', 'userMessageId'].every(key => a[key] === b[key]);
export class Permissions {
  constructor({ send, request, taskForSession, activeTaskIds = () => [], pause, resume }) {
    Object.assign(this, { send, request, taskForSession, activeTaskIds, pause, resume });
    this.pending = new Map();
    this.replies = new Set();
    this.retired = new Set();
  }
  async inspect(permission, owner) {
    if (!permission.tool?.messageID || !permission.tool?.callID) return null;
    const message = await this.request(`/session/${encodeURIComponent(permission.sessionID)}/message/${encodeURIComponent(permission.tool.messageID)}`, { directory: owner.directory, signal: AbortSignal.timeout(5000) });
    if (message.info?.sessionID !== permission.sessionID || message.info?.role !== 'assistant' || message.info?.parentID !== owner.userMessageId) return null;
    return message.parts?.find(p => p.type === 'tool' && p.callID === permission.tool.callID) || null;
  }
  async event(event) {
    const type = event.type || event.event, permission = event.properties || {};
    if (type === 'permission.replied') { await this.sync(); return; }
    if (!['permission.asked', 'permission.updated'].includes(type) || !permission.id || !permission.sessionID || this.retired.has(permission.id)) return;
    const owner = this.taskForSession(permission.sessionID);
    if (!owner) return;
    try {
      const tool = await this.inspect(permission, owner);
      if (this.retired.has(permission.id) || !tool || !['pending', 'running'].includes(tool.state?.status) || !identityMatches(owner, this.taskForSession(permission.sessionID))) return;
      const item = { type: 'permission.requested', requestId: permission.id, taskId: owner.taskId, attemptId: owner.attemptId, dispatchId: owner.dispatchId, request: permission, owner };
      this.pending.set(permission.id, item);
      this.pause(owner.taskId);
      const { owner: _, ...publicItem } = item;
      this.send(publicItem);
    } catch { /* No ownership evidence: retry during synchronization. */ }
  }
  resolve(requestId) {
    const item = this.pending.get(requestId);
    if (!item) return;
    this.retired.add(requestId);
    this.pending.delete(requestId);
    if (![...this.pending.values()].some(p => p.taskId === item.taskId)) this.resume(item.taskId);
    this.send({ type: 'permission.resolved', requestId, taskId: item.taskId, attemptId: item.attemptId, dispatchId: item.dispatchId });
  }
  async reply(message) {
    const item = this.pending.get(message.requestId);
    const result = (ok, error) => this.send({ type: 'permission.reply.result', requestId: message.requestId, replyId: message.replyId, taskId: item?.taskId, attemptId: item?.attemptId, dispatchId: item?.dispatchId, ok, error });
    if (!item || !identityMatches(item.owner, this.taskForSession(item.request.sessionID)) || ['taskId', 'attemptId', 'dispatchId'].some(key => message[key] !== item[key]) || !['once', 'always', 'reject'].includes(message.response)) {
      result(false, '审批请求已失效，请刷新后重试'); return;
    }
    if (this.replies.has(item.requestId)) { result(false, '该授权正在确认，请稍候'); return; }
    this.replies.add(item.requestId);
    try {
      const tool = await this.inspect(item.request, item.owner);
      if (!tool || !['pending', 'running'].includes(tool.state?.status) || !identityMatches(item.owner, this.taskForSession(item.request.sessionID))) throw Error('stale');
      await this.request(`/permission/${encodeURIComponent(message.requestId)}/reply`, {
        method: 'POST', directory: item.owner.directory, body: JSON.stringify({ response: message.response }), signal: AbortSignal.timeout(5000),
      });
      // HTTP success alone is not evidence that the waiting request was removed.
      const requests = await this.request('/permission', { directory: item.owner.directory, signal: AbortSignal.timeout(5000) });
      if (!Array.isArray(requests) || requests.some(p => p.id === item.requestId)) throw Error('unconfirmed');
      const continuedTool = await this.inspect(item.request, item.owner);
      if (!continuedTool || !['running', 'completed', 'error'].includes(continuedTool.state?.status) || !identityMatches(item.owner, this.taskForSession(item.request.sessionID))) throw Error('stale');
      this.resolve(message.requestId); result(true);
    } catch { result(false, '执行端尚未确认授权生效，请稍后重试'); }
    finally { this.replies.delete(item.requestId); }
  }
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const requests = await this.request('/permission', { signal: AbortSignal.timeout(5000) });
      if (!Array.isArray(requests)) return;
      const ids = new Set(requests.map(p => p.id));
      for (const [id, item] of this.pending) {
        if (!ids.has(id) || !identityMatches(item.owner, this.taskForSession(item.request.sessionID))) this.resolve(id);
        else {
          const tool = await this.inspect(item.request, item.owner);
          if (tool && !['pending', 'running'].includes(tool.state?.status)) this.resolve(id);
        }
      }
      for (const request of requests) await this.event({ type: 'permission.asked', properties: request });
      for (const taskId of this.activeTaskIds()) if (![...this.pending.values()].some(p => p.taskId === taskId)) this.send({ type: 'permission.resolved', taskId });
    } catch { /* Unknown transport state must not settle or approve requests. */ }
    finally { this.syncing = false; }
  }
  clearTask(taskId) {
    for (const [id, item] of this.pending) if (item.taskId === taskId) this.resolve(id);
  }
}
