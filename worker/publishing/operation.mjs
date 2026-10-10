import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseIntent } from './gate.mjs';
import { snapshotDigest } from '../../server/operation-proof.mjs';

export const PUBLISH_OPERATION = 'text-publication';
export async function immutableRecord(path, value) {
  let file;
  try { file = await open(path, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  const dir = await open(join(path, '..'), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  return true;
}
export class PublicationOperation {
  constructor({ directory, serviceURL, handler, fetcher = fetch }) { Object.assign(this, { directory, serviceURL, handler, fetcher }); }
  async preview(task) {
    const draft = parseIntent(task.prompt);
    if (!draft || task.workspaceId !== 'publish') return null;
    if (task.actor?.kind !== 'user' || !task.actor.authenticated) throw Error('AUTHENTICATION_REQUIRED');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const snapshotRef = randomUUID(), digest = snapshotDigest(draft);
    await immutableRecord(join(this.directory, `${snapshotRef}.json`), draft);
    return { plainText: true, text: `最终正文：\n\n${draft.text}\n\n公开范围：${draft.visibility}\n内容声明：${draft.statement}\n\n请审阅最终正文，在下方明确确认。修改后需要重新预览和审批。`, operationPreview: { targetId: PUBLISH_OPERATION, snapshotRef, digest } };
  }
  async request(message, readOnly = false) {
    try {
      if (!/^[a-f0-9-]{36}$/.test(message.snapshotRef)) throw Error('INVALID_SNAPSHOT');
      const draft = JSON.parse(await readFile(join(this.directory, `${message.snapshotRef}.json`), 'utf8'));
      if (snapshotDigest(draft) !== message.digest) throw Error('SNAPSHOT_CHANGED');
      let result;
      if (this.handler) result = await this.handler({ proof: message.proof, draft }, readOnly);
      else {
        const response = await this.fetcher(new URL(readOnly ? '/reconcile' : '/execute', this.serviceURL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof: message.proof, draft }), signal: AbortSignal.timeout(55000) });
        if (!response.ok) throw Error('SERVICE_REFUSED');
        result = await response.json();
      }
      return ['COMPLETED', 'FAILED', 'UNKNOWN'].includes(result.status) ? { status: result.status, reason: result.status === 'UNKNOWN' ? 'RESULT_UNVERIFIED' : result.status === 'FAILED' ? 'OPERATION_FAILED' : 'OK', resultUrl: /^https:\/\/weibo\.com\/detail\/[1-9]\d{0,19}$/.test(result.resultUrl || '') ? result.resultUrl : null } : { status: 'UNKNOWN', reason: 'INVALID_RESPONSE' };
    } catch { return { status: 'UNKNOWN', reason: 'RESULT_UNVERIFIED' }; }
  }
  async readPreview(message) {
    if (!/^[a-f0-9-]{36}$/.test(message.snapshotRef)) throw Error('INVALID_SNAPSHOT');
    const draft = JSON.parse(await readFile(join(this.directory, `${message.snapshotRef}.json`), 'utf8'));
    if (snapshotDigest(draft) !== message.digest) throw Error('SNAPSHOT_CHANGED');
    return { text: `最终正文：\n\n${draft.text}\n\n公开范围：${draft.visibility}\n内容声明：${draft.statement}`, digest: message.digest };
  }
}
