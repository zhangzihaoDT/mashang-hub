import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approvalProof, snapshotDigest } from '../server/operation-proof.mjs';
import { PublicationService, existingPublisher } from '../worker/publishing/service.mjs';
import { TaskStore } from '../server/task-store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'publication-unit-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const draft = { text: ' Mock 正文\n<script> & 中文 ', visibility: 'private', statement: 'ai' };
const record = () => ({ controlId: `control_${randomUUID()}`, operationId: `operation_${randomUUID()}`, targetId: 'text-publication', snapshotRef: randomUUID(), digest: snapshotDigest(draft) });
let calls = 0, external = null;
const options = { directory, publicKey, execute: async () => { calls++; return { status:'COMPLETED', resultUrl:'https://weibo.com/detail/1234567890123456789' }; }, reconcile: async () => external || { status:'UNKNOWN' } };
try {
  let service = new PublicationService(options);
  const control = record(), proof = approvalProof(control, privateKey);
  await assert.rejects(service.handle({draft}), /INVALID_APPROVAL/);
  await assert.rejects(service.handle({draft:{...draft,text:'changed'},proof}), /SNAPSHOT_MISMATCH/);
  await assert.rejects(service.handle({draft,proof:{...proof,signature:'invalid'}}));
  await assert.rejects(service.handle({draft,proof:approvalProof(record(),privateKey,0)}), /INVALID_APPROVAL/);
  assert.equal(calls,0);
  const results = await Promise.all(Array.from({length:10},()=>service.handle({draft,proof})));
  assert.equal(calls,1); assert.ok(results.some(result=>result.status==='COMPLETED'));
  service = new PublicationService(options);
  assert.equal((await service.handle({draft,proof},true)).status,'COMPLETED'); assert.equal(calls,1);
  const ambiguous = record(), lostProof = approvalProof(ambiguous,privateKey);
  service = new PublicationService({...options,execute:async()=>{calls++;throw Error('lost response');}});
  assert.equal((await service.handle({draft,proof:lostProof})).status,'UNKNOWN');
  assert.equal((await service.handle({draft,proof:lostProof})).status,'UNKNOWN'); assert.equal(calls,2);
  external = {status:'COMPLETED',resultUrl:'https://weibo.com/detail/999'};
  service = new PublicationService(options);
  assert.equal((await service.handle({draft,proof:lostProof},true)).status,'COMPLETED'); assert.equal(calls,2);
  await writeFile(join(directory, `${ambiguous.operationId}.result.json`),'{broken');
  await assert.rejects(service.handle({draft,proof:lostProof},true)); assert.equal(calls,2);

  const storePath=join(directory,'tasks.sqlite'); let store=new TaskStore(storePath);
  const t={...record(),taskId:'snapshot-task',status:'DRAFT',createdAt:Date.now()};
  store.save(t);store.save({...t,status:'PENDING_APPROVAL'});
  assert.throws(()=>store.approveSnapshot(t.taskId,'wrong',{}));
  store.approveSnapshot(t.taskId,t.digest,approvalProof(t,privateKey));
  assert.throws(()=>store.approveSnapshot(t.taskId,t.digest,{}));
  store.dispatch(t.taskId,{legacyStatus:'RUNNING'});store.close();
  store=new TaskStore(storePath);store.recover();assert.equal(store.get(t.taskId).status,'UNKNOWN');store.close();

  // Adapter contract: reuse publisher; capture its ID before any external call.
  const root=join(directory,'business');await mkdir(join(root,'src'),{recursive:true});
  await writeFile(join(root,'src/storage.mjs'),`import {writeFile,readFile,mkdir} from 'node:fs/promises';import {join,dirname} from 'node:path';export class Storage{constructor(root){this.root=root}async write(p,v){await mkdir(dirname(join(this.root,p)),{recursive:true});await writeFile(join(this.root,p),JSON.stringify(v))}async read(p){try{return JSON.parse(await readFile(join(this.root,p),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}}`);
  await writeFile(join(root,'src/weibo-client.mjs'),`export class WeiboClient {}`);
  await writeFile(join(root,'src/publisher.mjs'),`export async function publish(storage,client,options){await storage.write('logs/publish-11111111-1111-1111-1111-111111111111.json',{operation_id:'11111111-1111-1111-1111-111111111111',status:'UNCERTAIN'});await storage.write('raw/responses/publish-11111111-1111-1111-1111-111111111111.json',{raw:{data:{idstr:'888'}}});throw Error('archive failed')}`);
  const adapter=await existingPublisher({root,dataDirectory:join(root,'data'),directory});
  const operationId=record().operationId;
  assert.equal((await adapter.execute(draft,operationId)).status,'COMPLETED');
  assert.equal(JSON.parse(await readFile(join(directory,`${operationId}.business.json`),'utf8')).id,'11111111-1111-1111-1111-111111111111');
  console.log('Publication signatures, immutable approval, durable replay, UNKNOWN recovery and existing publisher adapter passed');
} finally { await rm(directory,{recursive:true,force:true}); }
