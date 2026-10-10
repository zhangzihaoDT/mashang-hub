import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicationService } from '../worker/publishing/service.mjs';

const temp=await mkdtemp(join(tmpdir(),'publication-bridge-'));
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let calls=0, loseResponse=false, hold=false, release, hub, worker, cookie='';
const streams=new Set(), external=new Map(), errors=[];
const executor=new PublicationService({directory:join(temp,'service'),publicKey,
  execute:async(draft,id)=>{calls++; if(hold)await new Promise(resolve=>{release=resolve}); const result={status:'COMPLETED',resultUrl:`https://weibo.com/detail/${1000+calls}`};external.set(id,result);return result;},
  reconcile:async id=>external.get(id)||{status:'UNKNOWN'}});
const service=createServer(async(req,res)=>{
  try{let text='';for await(const chunk of req)text+=chunk;const result=await executor.handle(JSON.parse(text),req.url==='/reconcile');if(loseResponse&&req.url==='/execute'){loseResponse=false;res.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}
  catch{res.writeHead(403);res.end('{}');}
});
const oc=createServer(async(req,res)=>{
  if(req.url.startsWith('/event')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': mock\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
  let text='';for await(const chunk of req)text+=chunk;
  res.setHeader('content-type','application/json');
  if(req.url.startsWith('/config/providers'))return res.end(JSON.stringify({providers:{deepseek:{id:'deepseek',models:{mock:{id:'mock',name:'DeepSeek Flash 4.1',status:'active'}}}}}));
  if(req.url.startsWith('/session')&&req.method==='POST'&&!req.url.includes('/message'))return res.end('{"id":"mock-session"}');
  if(req.url.includes('/message')){assert.equal(JSON.parse(text).tools,undefined);return res.end('{"parts":[{"type":"text","text":"Mock 草稿"}]}');}
  res.end('{}');
});
await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>oc.listen(0,'127.0.0.1',resolve));
const port=41000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
async function until(fn){for(let i=0;i<160;i++){try{const value=await fn();if(value)return value;}catch{}await sleep(40);}throw Error(`Bridge timeout: ${errors.join('')}`);}
async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
function startHub(){hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,HUB_TASK_DB:join(temp,'tasks.sqlite'),HUB_TURN_LOG:join(temp,'turns.jsonl'),HUB_HOST:'127.0.0.1',PORT:String(port),WORKER_SECRET:'mock',HUB_ACCESS_TOKEN:'mock-login',HUB_APPROVAL_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})},stdio:['ignore','ignore','pipe']});hub.stderr.on('data',chunk=>errors.push(chunk.toString()));}
function startWorker(){worker=spawn(process.execPath,['worker/worker.mjs'],{env:{...process.env,HUB_URL:base,WORKER_SECRET:'mock',WORKER_ID:'publication-test',WORKER_STATE_FILE:join(temp,'worker.json'),MASHANG_SERVICE_ROOT:temp,MYKNBASE_ROOT:temp,MASHANG_PUBLISH_ROOT:temp,MASHANG_PUBLISH_ENABLED:'0',MASHANG_PUBLISH_SERVICE_URL:`http://127.0.0.1:${service.address().port}`,MASHANG_PUBLISH_SNAPSHOT_DIR:join(temp,'snapshots'),OPENCODE_URL:`http://127.0.0.1:${oc.address().port}`,RUNTIME_SNAPSHOT_INTERVAL_MS:'60000'},stdio:['ignore','ignore','pipe']});worker.stderr.on('data',chunk=>errors.push(chunk.toString()));}
async function login(){await until(async()=> (await fetch(base+'/api/auth/status')).ok);const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"token":"mock-login"}'});cookie=response.headers.get('set-cookie').split(';')[0];}
async function control(id,status){return until(async()=>{const t=(await api(`/api/runtime/controls/${id}`)).data;return t.status===status&&t;});}
try{
  startHub();await login();startWorker();
  await until(async()=> (await api('/api/runtime')).data.snapshot?.operations?.some(item=>item.requiresSnapshot));
  const session=(await api('/api/sessions',{title:'Mock publication'})).data;
  async function draft(text){const before=(await api('/api/runtime/controls')).data.length;const result=await api(`/api/sessions/${session.id}/message`,{workspaceId:'publish',model:{providerID:'mock',modelID:'mock'},parts:[{type:'text',text:`发布微博：${text}`}]});assert.equal(result.status,202);return until(async()=>{const list=(await api('/api/runtime/controls')).data;return list.length>before&&list.at(-1);});}
  let c=await draft(' first Mock 文本\n & <script> ');assert.equal(c.status,'PENDING_APPROVAL');assert.equal(calls,0);
  assert.equal((await api(`/api/runtime/controls/${c.controlId}/preview`)).data.text.includes(' first Mock 文本\n & <script> '),true);
  assert.equal((await api('/api/runtime/control',{op:'run',targetId:c.targetId})).status,409);
  assert.equal((await api(`/api/runtime/controls/${c.controlId}/decision`,{approve:true,digest:'wrong'})).status,409);assert.equal(calls,0);
  const old=c;c=await draft('modified Mock 文本');assert.equal((await api(`/api/runtime/controls/${old.controlId}`)).data.status,'CANCELLED');
  assert.equal((await api(`/api/runtime/controls/${old.controlId}/decision`,{approve:true,digest:old.digest})).status,409);
  const click=()=>api(`/api/runtime/controls/${c.controlId}/decision`,{approve:true,digest:c.digest});
  const clicks=await Promise.all([click(),click(),click()]);assert.equal(clicks.filter(item=>item.status===200).length,1);
  await control(c.controlId,'COMPLETED');assert.equal(calls,1);
  hub.kill('SIGTERM');await once(hub,'exit');startHub();await login();
  await until(async()=> (await api('/api/health')).data.connected);
  assert.equal((await api(`/api/runtime/controls/${c.controlId}`)).data.status,'COMPLETED');assert.equal((await click()).status,409);assert.equal(calls,1);
  await until(async()=> (await api('/api/runtime')).data.snapshot?.operations?.length);
  loseResponse=true;c=await draft('lost response Mock');await click();await control(c.controlId,'UNKNOWN');assert.equal(calls,2);
  await api(`/api/runtime/controls/${c.controlId}/reconcile`,{});const recovered=await control(c.controlId,'COMPLETED');assert.match(recovered.resultUrl,/weibo\.com\/detail\//);assert.equal(calls,2);
  hold=true;c=await draft('disconnect Mock');await click();await until(()=>release);
  worker.kill('SIGKILL');await once(worker,'exit');await control(c.controlId,'UNKNOWN');
  release();hold=false;release=null;startWorker();await control(c.controlId,'COMPLETED');assert.equal(calls,3);
  const tasks=(await api('/api/tasks')).data;assert.equal(tasks.filter(item=>item.snapshotRef).length,4);
  assert.equal(tasks.some(item=>JSON.stringify(item).includes('modified Mock 文本')),false,'Hub persists metadata, never snapshot text');
  if(process.env.PUBLICATION_BROWSER==='1') {
    const {createRequire}=await import('node:module');
    const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
    const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
    try {
      const page=await browser.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
      await page.goto(base);await page.locator('#accessToken').fill('mock-login');await page.locator('#loginForm button').click();
      await page.locator('#send').waitFor({state:'visible'});await until(async()=>await page.locator('#send').isEnabled());
      await page.locator('[data-workspace="publish"]').click();
      const beforeCalls=calls;
      const original=' raw Mock UI\n<script>window.mockAttack=1</script> & 中文 ';
      await page.locator('#prompt').fill(original);await page.locator('#previewPublication').click();
      await page.locator('#approvePublication').waitFor();
      assert.ok((await page.locator('#resultContent').textContent()).includes(original));
      assert.equal(await page.evaluate(()=>window.mockAttack),undefined);assert.equal(calls,beforeCalls);
      await page.locator('#approvePublication').click();
      await page.locator('#publicationReview a').waitFor();assert.equal(calls,beforeCalls+1);
      await page.reload();await until(async()=>await page.locator('#send').isEnabled());
      await page.locator('[data-workspace="publish"]').click();await page.locator('#publicationReview a').waitFor();assert.equal(calls,beforeCalls+1);
      await page.locator('#prompt').fill('待修改草稿');await page.locator('#previewPublication').click();await page.locator('#approvePublication').waitFor();
      await page.locator('#prompt').fill('修改后的正文');await until(async()=>await page.locator('#approvePublication').count()===0);assert.equal(calls,beforeCalls+1);
      assert.deepEqual(pageErrors,[]);
      console.log('Publish browser: exact text preview, explicit approval, link, reload recovery and edit invalidation passed');
    } finally {await browser.close();}
  }
  console.log('Hub → real Worker → Mock service: preview, approval, edit invalidation, duplicate click, Hub restart, lost response and Worker crash reconciliation passed');
}finally{
  for(const child of [worker,hub])if(child?.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  for(const stream of streams)stream.destroy();
  service.closeAllConnections();oc.closeAllConnections();await Promise.all([new Promise(resolve=>service.close(resolve)),new Promise(resolve=>oc.close(resolve))]);
  await rm(temp,{recursive:true,force:true});
}
