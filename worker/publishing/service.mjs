// Deploy under the isolated publishing OS identity; never start from the Agent.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { snapshotDigest, verifyProof } from '../../server/operation-proof.mjs';
import { immutableRecord, PUBLISH_OPERATION } from './operation.mjs';

export class PublicationService {
  constructor({ directory, publicKey, execute, reconcile }) { Object.assign(this, { directory, publicKey, execute, reconcile }); }
  async load(id, suffix) {
    try { return JSON.parse(await readFile(join(this.directory, `${id}.${suffix}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async handle({ proof, draft }, readOnly = false) {
    const approval = verifyProof(proof, this.publicKey, { readOnly });
    if (approval.targetId !== PUBLISH_OPERATION || snapshotDigest(draft) !== approval.digest) throw Error('SNAPSHOT_MISMATCH');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = approval.operationId;
    const previous = await this.load(id, 'claim');
    if (previous && (previous.digest !== approval.digest || previous.snapshotRef !== approval.snapshotRef || previous.taskId !== approval.taskId)) throw Error('OPERATION_MISMATCH');
    const result = await this.load(id, 'result');
    if (result) return result;
    if (readOnly || previous) {
      if (!previous) return { status: 'UNKNOWN' };
      let evidence;
      try { evidence = await this.reconcile(id); } catch { return { status: 'UNKNOWN' }; }
      if (['COMPLETED', 'FAILED'].includes(evidence?.status)) { await immutableRecord(join(this.directory, `${id}.result.json`), evidence); return evidence; }
      return { status: 'UNKNOWN' };
    }
    if (!await immutableRecord(join(this.directory, `${id}.claim.json`), approval)) return this.handle({ proof, draft }, true);
    try {
      const outcome = await this.execute(draft, id);
      if (['COMPLETED', 'FAILED'].includes(outcome?.status)) { await immutableRecord(join(this.directory, `${id}.result.json`), outcome); return outcome; }
    } catch { /* Claim remains permanent, verify only. */ }
    return { status: 'UNKNOWN' };
  }
}

// Reuse the existing publisher, archive lock and official CLI client unchanged.
export async function existingPublisher({ root, dataDirectory, directory }) {
  const moduleAt = name => import(pathToFileURL(join(root, 'src', name)).href);
  const [{ Storage }, { publish }, { WeiboClient }] = await Promise.all([moduleAt('storage.mjs'), moduleAt('publisher.mjs'), moduleAt('weibo-client.mjs')]);
  const storage = new Storage(dataDirectory);
  const evidence = async id => {
    let mapping;
    try { mapping = JSON.parse(await readFile(join(directory, `${id}.business.json`), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { status: 'UNKNOWN' }; throw error; }
    const log = await storage.read(`logs/publish-${mapping.id}.json`);
    const raw = await storage.read(`raw/responses/publish-${mapping.id}.json`);
    const post = raw?.raw?.data ?? raw?.raw;
    const postId = log?.status === 'PUBLISHED' ? log.idstr : post?.idstr;
    if (typeof postId === 'string' && /^[1-9]\d{0,19}$/.test(postId)) return { status: 'COMPLETED', resultUrl: `https://weibo.com/detail/${postId}` };
    return { status: log?.status === 'FAILED' ? 'FAILED' : 'UNKNOWN' };
  };
  return {
    reconcile: evidence,
    execute: async (draft, id) => {
      // Persist cross-layer association before publisher reaches client.publish.
      const scoped = new Storage(dataDirectory);
      const write = scoped.write.bind(scoped);
      scoped.write = async (relative, value, options) => {
        if (/^logs\/publish-[a-f0-9-]{36}\.json$/.test(relative)) {
          await immutableRecord(join(directory, `${id}.business.json`), { id: value.operation_id });
        }
        return write(relative, value, options);
      };
      try { await publish(scoped, new WeiboClient(), { ...draft, confirm: true }); } catch { /* Read durable evidence. */ }
      return evidence(id);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.PUBLISH_SERVICE_STATE;
  const root = process.env.PUBLISH_SERVICE_ROOT;
  const dataDirectory = process.env.PUBLISH_SERVICE_DATA;
  if (!directory || !root || !dataDirectory || !process.env.PUBLISH_SERVICE_PUBLIC_KEY_FILE) throw Error('SERVICE_CONFIGURATION_REQUIRED');
  const publicKey = await readFile(process.env.PUBLISH_SERVICE_PUBLIC_KEY_FILE, 'utf8');
  const service = new PublicationService({ directory, publicKey, ...await existingPublisher({ root, dataDirectory, directory }) });
  createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !['/execute', '/reconcile'].includes(req.url)) throw Error('INVALID_REQUEST');
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 100000) throw Error('REQUEST_TOO_LARGE'); }
      const result = await service.handle(JSON.parse(body), req.url === '/reconcile');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'REQUEST_REFUSED' })); }
  }).listen(Number(process.env.PUBLISH_SERVICE_PORT || 4381), '127.0.0.1');
}
