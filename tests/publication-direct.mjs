import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const temp=await mkdtemp(join(tmpdir(),'publish-direct-'));
const root=join(temp,'business');await mkdir(join(root,'src'),{recursive:true});
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const publicKeyFile=join(temp,'public.pem');await writeFile(publicKeyFile,publicKey.export({type:'spki',format:'pem'}));
await writeFile(join(root,'src/storage.mjs'),`import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join,dirname} from 'node:path';export class Storage{constructor(root){this.root=root}async write(p,v){await mkdir(dirname(join(this.root,p)),{recursive:true});await writeFile(join(this.root,p),JSON.stringify(v));}async read(p){try{return JSON.parse(await readFile(join(this.root,p),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}}`);
await writeFile(join(root,'src/weibo-client.mjs'),'export class WeiboClient {}');
await writeFile(join(root,'src/publisher.mjs'),`import {randomUUID} from 'node:crypto';import {appendFile} from 'node:fs/promises';export async function publish(storage,client,options){const id=randomUUID();await storage.write('logs/publish-'+id+'.json',{operation_id:id,status:'UNCERTAIN'});await appendFile(${JSON.stringify(join(temp,'calls.jsonl'))},JSON.stringify(options)+'\\n');await storage.write('raw/responses/publish-'+id+'.json',{raw:{data:{idstr:'1234567890123456789'}}});await storage.write('logs/publish-'+id+'.json',{operation_id:id,status:'PUBLISHED',idstr:'1234567890123456789'});}`);
let draftRequest;
const streams=new Set();const oc=createServer(async(req,res)=>{
 if(req.url.startsWith('/event')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': Mock\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 res.setHeader('content-type','application/json');
 if(req.method==='POST' && req.url.startsWith('/session/')){let body='';for await(const chunk of req)body+=chunk;draftRequest=JSON.parse(body);res.end(JSON.stringify({info:{},parts:[{type:'text',text:'Mock 文案'}]}));return;}
 if(req.method==='POST' && req.url.startsWith('/session')){res.end(JSON.stringify({id:'ses_mock_draft'}));return;}
 res.end('{}');
});await new Promise(resolve=>oc.listen(0,'127.0.0.1',resolve));
const port=43000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let hub,worker,cookie='';
async function until(fn){for(let i=0;i<150;i++){try{const result=await fn();if(result)return result;}catch{}await sleep(40);}throw Error('Direct bridge timeout');}
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
function startHub(){hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),HUB_HOST:'127.0.0.1',HUB_TASK_DB:join(temp,'tasks.sqlite'),HUB_TURN_LOG:join(temp,'turns.jsonl'),WORKER_SECRET:'mock-direct',HUB_ACCESS_TOKEN:'mock-access',HUB_APPROVAL_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})},stdio:'ignore'});}
function startWorker(){worker=spawn(process.execPath,['worker/worker.mjs'],{env:{...process.env,HUB_URL:base,WORKER_SECRET:'mock-direct',WORKER_ID:'direct-test',MASHANG_SERVICE_ROOT:temp,MYKNBASE_ROOT:temp,OPENCODE_URL:`http://127.0.0.1:${oc.address().port}`,WORKER_STATE_FILE:join(temp,'worker.json'),MASHANG_PUBLISH_ENABLED:'0',MASHANG_PUBLISH_SERVICE_URL:'',MASHANG_PUBLISH_DIRECT:'1',MASHANG_PUBLISH_ROOT:root,MASHANG_PUBLISH_PUBLIC_KEY_FILE:publicKeyFile,MASHANG_PUBLISH_LEDGER_DIR:join(temp,'ledger'),MASHANG_PUBLISH_SNAPSHOT_DIR:join(temp,'snapshots')},stdio:'ignore'});}
async function login(){await until(async()=> (await fetch(base+'/api/auth/status')).ok);const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"token":"mock-access"}'});cookie=response.headers.get('set-cookie').split(';')[0];}
async function calls(){try{return (await readFile(join(temp,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
try{
 startHub();await login();startWorker();await until(async()=> (await api('/api/runtime')).data.snapshot?.operations?.some(o=>o.requiresSnapshot));
 const draftSession=(await api('/api/sessions',{})).data;
 await api(`/api/sessions/${draftSession.id}/message`,{workspaceId:'publish',parts:[{type:'text',text:'请打磨这句观点'}]});
 await until(()=>draftRequest);assert.deepEqual(draftRequest.tools,{'*':false});assert.match(draftRequest.parts[0].text,/不调用工具或等待交互式提问/);
 await until(async()=> (await api('/api/tasks')).data.some(t=>t.conversationId===draftSession.id && t.status==='COMPLETED'));
 const session=(await api('/api/sessions',{})).data;
 await api(`/api/sessions/${session.id}/message`,{workspaceId:'publish',parts:[{type:'text',text:'发布微博[private,ai]： direct Mock 正文\n中文 & <script> '}]});
 const control=await until(async()=> (await api('/api/runtime/controls')).data[0]);assert.equal(control.status,'PENDING_APPROVAL');assert.equal((await calls()).length,0);
 const decision=()=>api(`/api/runtime/controls/${control.controlId}/decision`,{approve:true,digest:control.digest});
 const results=await Promise.all([decision(),decision()]);assert.equal(results.filter(r=>r.status===200).length,1);
 await until(async()=> (await api(`/api/runtime/controls/${control.controlId}`)).data.status==='COMPLETED');
 const records=await calls();assert.equal(records.length,1);assert.equal(records[0].text,' direct Mock 正文\n中文 & <script> ');assert.equal(records[0].visibility,'private');assert.equal(records[0].statement,'ai');
 worker.kill('SIGTERM');await once(worker,'exit');hub.kill('SIGTERM');await once(hub,'exit');
 startHub();await login();startWorker();await until(async()=> (await api('/api/health')).data.connected);
 assert.equal((await decision()).status,409);assert.equal((await calls()).length,1);
 assert.equal((await api(`/api/runtime/controls/${control.controlId}`)).data.resultUrl,'https://weibo.com/detail/1234567890123456789');
 console.log('Direct Hub → Worker → existing publisher adapter Mock: no service, approval, exact scope, duplicate click and process restart passed');
}finally{
 for(const child of [worker,hub])if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
 for(const stream of streams)stream.destroy();oc.closeAllConnections();await new Promise(resolve=>oc.close(resolve));await rm(temp,{recursive:true,force:true});
}
