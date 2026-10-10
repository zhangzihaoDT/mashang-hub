import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FINAL_TASK_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const STATES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'UNKNOWN', 'CREATED', 'QUEUED', 'AWAITING_APPROVAL', 'DISPATCHED', 'RUNNING', 'INTERRUPTED', 'UNCERTAIN', ...FINAL_TASK_STATES]);
const transitions = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
  APPROVED: ['DISPATCHED', 'UNKNOWN'],
  UNKNOWN: ['COMPLETED', 'FAILED'],
  CREATED: ['QUEUED', 'AWAITING_APPROVAL', 'DISPATCHED', 'FAILED', 'CANCELLED'],
  QUEUED: ['DISPATCHED', 'CANCELLED', 'FAILED'],
  AWAITING_APPROVAL: ['DISPATCHED', 'CANCELLED', 'FAILED'],
  DISPATCHED: ['UNKNOWN', 'RUNNING', 'INTERRUPTED', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'CANCELLED'],
  RUNNING: ['UNKNOWN', 'INTERRUPTED', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'CANCELLED'],
  INTERRUPTED: ['UNKNOWN', 'RUNNING', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'CANCELLED'],
  UNCERTAIN: ['UNKNOWN', 'COMPLETED', 'FAILED'],
};
const fields = ['taskId', 'conversationId', 'source', 'executor', 'workspaceId', 'workerId', 'status', 'attempt', 'attemptId', 'dispatchId', 'operationId', 'policy', 'createdAt', 'startedAt', 'updatedAt', 'finishedAt', 'lastProgressAt', 'reason', 'legacyStatus', 'turnId', 'model', 'op', 'targetId', 'hasText', 'artifactCount', 'externalEffectPossible', 'cancellationSupported', 'cancelRequested', 'cancelSource', 'snapshotRef', 'digest', 'proof', 'resultUrl'];
export function taskRecord(input) { return Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]])); }

export class TaskStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Task database schema is newer than this Hub');
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), decision TEXT NOT NULL, decided_at INTEGER NOT NULL, actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (dispatch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), attempt_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), status TEXT NOT NULL, reason TEXT, ts INTEGER NOT NULL);
      PRAGMA user_version=2;
    `));
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(id) { const row = this.db.prepare('SELECT record FROM tasks WHERE task_id=?').get(id); return row ? JSON.parse(row.record) : null; }
  list() { return this.db.prepare('SELECT record FROM tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.record)); }
  save(input) {
    const record = taskRecord(input);
    if (!STATES.has(record.status)) throw new Error('Invalid task status');
    const old = this.get(record.taskId);
    if (old && FINAL_TASK_STATES.has(old.status)) return old;
    if (old && old.status !== record.status && !transitions[old.status]?.includes(record.status)) throw new Error(`Invalid task transition: ${old.status} -> ${record.status}`);
    return this.transaction(() => {
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, record=excluded.record').run(record.taskId, record.status, JSON.stringify(record));
      if (!old || old.status !== record.status) this.db.prepare('INSERT INTO task_events(task_id,status,reason,ts) VALUES (?,?,?,?)').run(record.taskId, record.status, record.reason || null, record.updatedAt || record.createdAt);
      return record;
    });
  }
  dispatch(id, patch = {}) {
    const old = this.get(id);
    if (!old || !['APPROVED', 'CREATED', 'QUEUED', 'AWAITING_APPROVAL'].includes(old.status)) throw new Error('Task is not dispatchable');
    return this.transaction(() => {
      const record = taskRecord({ ...old, ...patch, status: 'DISPATCHED', attempt: 1, attemptId: `attempt_${randomUUID()}`, dispatchId: `dispatch_${randomUUID()}`, updatedAt: Date.now() });
      this.db.prepare('UPDATE tasks SET status=?,record=? WHERE task_id=?').run(record.status, JSON.stringify(record), id);
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?)').run(record.dispatchId, id, record.attemptId, record.updatedAt);
      this.db.prepare('INSERT INTO task_events(task_id,status,ts) VALUES (?,?,?)').run(id, record.status, record.updatedAt);
      if (old.status === 'AWAITING_APPROVAL') this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?)').run(id, 'APPROVED', record.updatedAt, 'user');
      return record;
    });
  }
  approveSnapshot(id, digest, proof) {
    return this.transaction(() => {
      const old = this.get(id);
      if (!old || old.status !== 'PENDING_APPROVAL' || old.digest !== digest) throw Error('Approval snapshot changed');
      const record = taskRecord({ ...old, proof, status: 'APPROVED', legacyStatus: 'APPROVED', updatedAt: Date.now() });
      this.db.prepare('UPDATE tasks SET status=?,record=? WHERE task_id=?').run(record.status, JSON.stringify(record), id);
      this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?)').run(id, 'APPROVED', record.updatedAt, 'user');
      this.db.prepare('INSERT INTO task_events(task_id,status,ts) VALUES (?,?,?)').run(id, record.status, record.updatedAt);
      return record;
    });
  }
  reject(id, status, reason) {
    const old = this.get(id);
    if (!old || old.status !== 'AWAITING_APPROVAL') throw new Error('Approval already decided');
    return this.transaction(() => {
      const record = taskRecord({ ...old, status, reason, legacyStatus: reason === 'USER_REJECTED' ? 'REJECTED' : status, updatedAt: Date.now(), finishedAt: Date.now() });
      this.db.prepare('UPDATE tasks SET status=?,record=? WHERE task_id=?').run(status, JSON.stringify(record), id);
      this.db.prepare('INSERT INTO approvals VALUES (?,?,?,?)').run(id, 'REJECTED', record.updatedAt, 'user');
      this.db.prepare('INSERT INTO task_events(task_id,status,reason,ts) VALUES (?,?,?,?)').run(id, status, reason, record.updatedAt);
      return record;
    });
  }
  saveSession(session) {
    const record = { id: session.id, title: 'mashang-hub', workerId: session.workerId, openCodeSessionId: session.openCodeSessionId, turnCount: session.turnCount, createdAt: session.createdAt };
    this.db.prepare('INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
  }
  sessions() { return this.db.prepare('SELECT record FROM conversations').all().map(row => JSON.parse(row.record)); }
  recover() {
    for (const record of this.list()) if (['APPROVED', 'DISPATCHED', 'RUNNING'].includes(record.status)) this.save({ ...record, status: record.snapshotRef ? 'UNKNOWN' : record.externalEffectPossible ? 'UNCERTAIN' : 'INTERRUPTED', legacyStatus: record.snapshotRef ? 'UNKNOWN' : 'INTERRUPTED', updatedAt: Date.now(), reason: 'HUB_RESTARTED' });
  }
  close() { this.db.close(); }
}
