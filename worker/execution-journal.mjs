import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// Local execution evidence and result outbox. A saved RUNNING entry alone is never liveness proof.
export class ExecutionJournal {
  constructor(path) {
    this.path = path; this.entries = {};
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { this.entries = JSON.parse(readFileSync(path, 'utf8')); if (!this.entries || Array.isArray(this.entries) || typeof this.entries !== 'object') throw new Error('Invalid journal'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.flush();
  }
  flush() {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 }); chmodSync(temporary, 0o600);
    let fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    fd = openSync(dirname(this.path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  begin(message) {
    const id = message.taskId || message.controlId;
    if (this.entries[id]) return false;
    this.entries[id] = { taskId: id, attemptId: message.attemptId || null, dispatchId: message.dispatchId || null, status: 'RUNNING', startedAt: Date.now(), lastProgressAt: Date.now(), executor: message.controlId ? 'operation' : 'agent', events: [] };
    this.flush(); return true;
  }
  record(message) {
    const entry = this.entries[message.taskId || message.controlId];
    if (!entry) return message;
    const event = { ...message, attemptId: entry.attemptId, dispatchId: entry.dispatchId };
    if (message.type === 'opencode.progress') { entry.lastProgressAt = Date.now(); this.flush(); }
    if (message.externalEffectPossible) { entry.externalEffectPossible = true; this.flush(); }
    if (['artifact.created', 'agent.message.completed', 'task.completed', 'task.cancelled', 'task.failed', 'runtime.control.result'].includes(message.type)) {
      entry.events.push(event);
      if (['task.completed', 'task.cancelled', 'task.failed', 'runtime.control.result'].includes(message.type)) entry.status = 'RESULT';
      this.flush();
    }
    return event;
  }
  reconcile(requests, live) {
    return requests.map(request => {
      const entry = this.entries[request.taskId];
      if (!entry || entry.attemptId !== request.attemptId || entry.dispatchId !== request.dispatchId) return { ...request, state: 'UNKNOWN' };
      const state = entry.status === 'RESULT' ? 'RESULT' : live(entry.taskId, entry.executor) ? 'RUNNING' : entry.externalEffectPossible || entry.executor === 'operation' ? 'UNCERTAIN' : 'INTERRUPTED';
      return { taskId: entry.taskId, attemptId: entry.attemptId, dispatchId: entry.dispatchId, state, startedAt: entry.startedAt, lastProgressAt: entry.lastProgressAt, externalEffectPossible: Boolean(entry.externalEffectPossible), events: state === 'RESULT' ? entry.events : [] };
    });
  }
}
