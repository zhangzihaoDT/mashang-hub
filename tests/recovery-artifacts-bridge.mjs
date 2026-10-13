import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'hub-partials-'));
mkdirSync(join(directory, 'outputs'));
const port = 41000 + Math.floor(Math.random()*1000), base = `http://127.0.0.1:${port}`;
let hub, worker, browser, page, logs = '', count = 0;
const sessions = new Map(), permissions = new Map(), streams = new Set();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function emit(event) { for (const s of streams) s.write(`data: ${JSON.stringify(event)}\n\n`); }
const oc = createServer(async(req,res)=>{
 const path = new URL(req.url,'http://localhost').pathname; let data='';for await(const chunk of req)data+=chunk;
 if(path==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': ready\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
 res.setHeader('content-type','application/json'); const done=v=>res.end(JSON.stringify(v));
 if(path==='/config/providers')return done({providers:{}});
 if(path==='/permission')return done([...permissions.values()]);
 if(path==='/session/status')return done(Object.fromEntries([...sessions].filter(([,s])=>s.busy).map(([id])=>[id,{type:'busy'}])));
 if(path==='/session'&&req.method==='POST'){const id=`ses-${++count}`;sessions.set(id,{messages:[],busy:false});return done({id});}
 const reply=path.match(/^\/permission\/([^/]+)\/reply$/);
 if(reply){assert.deepEqual(JSON.parse(data),{reply:'once'});const p=permissions.get(reply[1]);permissions.delete(reply[1]);emit({type:'permission.replied',properties:{requestID:reply[1],sessionID:p.sessionID}});setTimeout(()=>finish(p.sessionID),100);return done(true);}
 const m=path.match(/^\/session\/([^/]+)\/(message|abort)(?:\/([^/]+))?$/);if(!m)return done({});
 const s=sessions.get(m[1]);if(m[2]==='abort'){s.busy=false;s.aborted=true;clearTimeout(s.timer);const v={info:{id:'aborted',role:'assistant',parentID:s.user,error:{name:'MessageAbortedError'},time:{completed:Date.now()}},parts:[]};s.messages.push(v);if(!s.response.destroyed)s.response.end(JSON.stringify(v));return done(true);}
 if(req.method==='GET')return done(m[3]?s.messages.find(v=>v.info.id===m[3]):s.messages);
 const input=JSON.parse(data);s.user=input.messageID;s.mode=input.parts[0].text;s.response=res;s.busy=true;s.messages=[{info:{id:s.user,role:'user'},parts:[]}];
 if(s.mode==='approval'){
  const id=`per-${m[1]}`, messageID=`msg-${m[1]}`, callID=`call-${m[1]}`;
  s.messages.push({info:{id:messageID,sessionID:m[1],role:'assistant',parentID:s.user},parts:[{type:'tool',callID,tool:'read',state:{status:'running',time:{start:Date.now()}}}]});
  const p={id,sessionID:m[1],permission:'external_directory',patterns:['/profile/*'],tool:{messageID,callID}};permissions.set(id,p);emit({type:'permission.asked',properties:p});
 }else s.timer=setTimeout(()=>makeArtifact(m[1]),80);
});
function makeArtifact(id){const s=sessions.get(id), path=`outputs/${id}.html`;writeFileSync(join(directory,path),'<html><body>partial result</body></html>');const part={sessionID:id,type:'tool',tool:'write',callID:'write-'+id,state:{status:'completed',input:{filePath:path},output:'written '+path,time:{start:Date.now()-1,end:Date.now()}}};s.messages.push({info:{id:'write-'+id,sessionID:id,role:'assistant',parentID:s.user,finish:'tool-calls'},parts:[part]});emit({type:'message.part.updated',properties:{part}});}
function finish(id){const s=sessions.get(id);makeArtifact(id);s.busy=false;const v={info:{id:'final-'+id,role:'assistant',parentID:s.user,finish:'stop',time:{completed:Date.now()}},parts:[{type:'text',text:'done'}]};s.messages.push(v);if(!s.response.destroyed)s.response.end(JSON.stringify(v));}
await new Promise(r=>oc.listen(0,'127.0.0.1',r));
const env={...process.env,HUB_ACCESS_TOKEN:'',WORKER_SECRET:'partial-test',MASHANG_PUBLISH_ENABLED:'0',MASHANG_PUBLISH_DIRECT:'0',MASHANG_PUBLISH_SERVICE_URL:''};
function watch(p){p.stdout.on('data',v=>logs+=v);p.stderr.on('data',v=>logs+=v);return p;}
function startHub(){hub=watch(spawn(process.execPath,['server.mjs'],{env:{...env,PORT:String(port),HUB_HOST:'127.0.0.1',HUB_TASK_DB:join(directory,'tasks.sqlite'),HUB_TURN_LOG:join(directory,'turns.jsonl'),TASK_CANCEL_GRACE_MS:'300'},stdio:['ignore','pipe','pipe']}));}
function startWorker(){worker=watch(spawn(process.execPath,['worker/worker.mjs'],{env:{...env,HUB_URL:base,MASHANG_SERVICE_ROOT:directory,MYKNBASE_ROOT:directory,OPENCODE_URL:`http://127.0.0.1:${oc.address().port}`,WORKER_STATE_FILE:join(directory,'worker.json'),WORKER_HEARTBEAT_MS:'80',RUNTIME_SNAPSHOT_INTERVAL_MS:'600000'},stdio:['ignore','pipe','pipe']}));}
async function stop(p){if(p?.exitCode===null){const e=once(p,'exit');p.kill('SIGKILL');await e;}}
async function api(path,data){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined});assert.ok(r.ok,path+' '+r.status);return r.json();}
async function until(fn){for(let i=0;i<200;i++){try{const r=await fn();if(r)return r;}catch{}await sleep(25);}throw Error(logs);}
async function submit(mode,budget){const s=await api('/api/sessions',{});return api(`/api/sessions/${s.id}/message`,{parts:[{type:'text',text:mode}],policy:{executionDeadlineMs:budget,progressTimeoutMs:100}});}
try{
 startHub();await until(()=>api('/api/health'));startWorker();await until(async()=>(await api('/api/health')).worker?.id);
 const approval=await submit('approval',600);await until(async()=>(await api('/api/permissions')).length);
 await sleep(300);await stop(worker);await stop(hub);startHub();await until(()=>api('/api/health'));startWorker();
 await until(async()=>(await api('/api/permissions')).length);await sleep(700);
 const waiting=await api(`/api/tasks/${approval.taskId}`);assert.equal(waiting.status,'RUNNING');assert.ok(waiting.permissionStartedAt);
 const p=(await api('/api/permissions'))[0];await api(`/api/permissions/${p.requestId}/reply`,{response:'once'});
 await until(async()=>(await api(`/api/tasks/${approval.taskId}`)).status==='COMPLETED');assert.ok((await api(`/api/tasks/${approval.taskId}`)).permissionWaitMs>=1000);
 assert.equal(count,1,'restart must never replay the prompt');
 const partial=await submit('partial',600);await until(async()=>(await api(`/api/tasks/${partial.taskId}/artifacts`)).length);
 await until(async()=>(await api(`/api/tasks/${partial.taskId}`)).legacyStatus==='TIMEOUT');
 let artifacts=await api(`/api/tasks/${partial.taskId}/artifacts`);assert.equal(artifacts.length,1);
 assert.equal((await fetch(`${base}/api/artifacts/content?artifactId=${artifacts[0].artifactId}`)).status,200);
 if(process.env.RECOVERY_BROWSER){
  const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(id=>localStorage.setItem('mashang-hub-session',id),partial.sessionId);await page.goto(base);await page.waitForSelector('.artifact-card');
  assert.match(await page.locator('#runState').textContent(),/执行超时/);assert.match(await page.locator('.artifacts-title').textContent(),/部分产物.*任务未完成/);
  await page.locator('[data-action="preview"]').click();await page.waitForSelector('.artifact-frame');
  await page.reload();await page.waitForSelector('.artifact-card');assert.match(await page.locator('#runState').textContent(),/执行超时/);
  await page.screenshot({path:'/tmp/hub-partial-artifacts.png',fullPage:true});
 }

 await stop(worker);await stop(hub);startHub();await until(()=>api('/api/health'));startWorker();
 await until(async()=>(await api(`/api/tasks/${partial.taskId}/artifacts`)).length);
 artifacts=await api(`/api/tasks/${partial.taskId}/artifacts`);assert.equal(artifacts.length,1);assert.equal((await api(`/api/tasks/${partial.taskId}`)).legacyStatus,'TIMEOUT');
 const r=await fetch(`${base}/api/artifacts/content?artifactId=${artifacts[0].artifactId}`);assert.equal(r.status,200);assert.match(await r.text(),/partial result/);
 if(page){await page.reload();await page.waitForSelector('.artifact-card');assert.match(await page.locator('#runState').textContent(),/执行超时/);}
 // Simulate an older Worker that settled without registering tool-generated files.
 await stop(worker);await stop(hub);
 const journalPath=join(directory,'worker.json.executions.json'), journal=JSON.parse(readFileSync(journalPath));
 journal[partial.taskId].events=journal[partial.taskId].events.filter(e=>e.type!=='artifact.created');delete journal[partial.taskId].finishedAt;writeFileSync(journalPath,JSON.stringify(journal));
 startHub();await until(()=>api('/api/health'));startWorker();
 await until(async()=>(await api(`/api/tasks/${partial.taskId}/artifacts`)).length);
 artifacts=await api(`/api/tasks/${partial.taskId}/artifacts`);assert.equal((await api(`/api/tasks/${partial.taskId}`)).legacyStatus,'TIMEOUT');
 writeFileSync(join(directory,'outputs/ses-2.html'),'changed after task');
 assert.equal((await fetch(`${base}/api/artifacts/content?artifactId=${artifacts[0].artifactId}`)).status,404,'changed files must not masquerade as original artifacts');
 assert.equal(count,2,'artifact recovery must not run either task again');
 console.log('Real Hub/Worker: approval clock survives both restarts; timed-out HTML remains downloadable after restart without replay');
}finally{await browser?.close();await stop(worker);await stop(hub);for(const s of sessions.values())clearTimeout(s.timer);for(const s of streams)s.destroy();oc.closeAllConnections();await new Promise(r=>oc.close(r));rmSync(directory,{recursive:true,force:true});}
