// OpenCode owns approval decisions; the Worker only relays confirmed results.
export class Permissions {
  constructor({ send, request, taskForSession, directoryForSession, activeTaskIds = () => [], pause, resume }) {
    Object.assign(this, { send, request, taskForSession, directoryForSession, activeTaskIds, pause, resume });
    this.pending = new Map();
  }
  event(event) {
    const type = event.type || event.event;
    const request = event.properties || {};
    const requestId = request.id || request.requestID || request.permissionID;
    if (!requestId) return;
    if (['permission.asked', 'permission.updated'].includes(type) && request.sessionID) {
      const taskId = this.taskForSession(request.sessionID);
      if (!taskId) return;
      const item = { type: 'permission.requested', requestId, taskId, request };
      this.pending.set(requestId, item);
      this.pause(taskId);
      this.send(item);
    } else if (type === 'permission.replied') this.resolve(requestId);
  }
  resolve(requestId) {
    const item = this.pending.get(requestId);
    if (!item) return;
    this.pending.delete(requestId);
    if (![...this.pending.values()].some(p => p.taskId === item.taskId)) this.resume(item.taskId);
    this.send({ type: 'permission.resolved', requestId, taskId: item.taskId });
  }
  async reply(message) {
    const item = this.pending.get(message.requestId);
    if (!item || !['once', 'always', 'reject'].includes(message.response)) {
      this.send({ type: 'permission.reply.result', requestId: message.requestId, replyId: message.replyId, ok: false, error: '审批请求已失效，请刷新后重试' });
      return;
    }
    try {
      await this.request(`/permission/${encodeURIComponent(message.requestId)}/reply`, {
        method: 'POST', directory: this.directoryForSession(item.request.sessionID),
        body: JSON.stringify({ response: message.response }), signal: AbortSignal.timeout(10000),
      });
      this.resolve(message.requestId);
      this.send({ type: 'permission.reply.result', requestId: message.requestId, replyId: message.replyId, taskId: item.taskId, ok: true });
    } catch {
      this.send({ type: 'permission.reply.result', requestId: message.requestId, replyId: message.replyId, taskId: item.taskId, ok: false, error: 'OpenCode 未确认审批，请重试' });
    }
  }
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const requests = await this.request('/permission', { signal: AbortSignal.timeout(10000) });
      if (!Array.isArray(requests)) return;
      const ids = new Set(requests.map(p => p.id));
      for (const id of this.pending.keys()) if (!ids.has(id)) this.resolve(id);
      for (const request of requests) this.event({ type: 'permission.asked', properties: request });
      for (const taskId of this.activeTaskIds()) if (![...this.pending.values()].some(p => p.taskId === taskId)) this.send({ type: 'permission.resolved', taskId });
    } catch { /* Retry on the next heartbeat or event reconnect. */ } finally { this.syncing = false; }
  }
  clearTask(taskId) {
    for (const [id, item] of this.pending) if (item.taskId === taskId) this.resolve(id);
  }
}
