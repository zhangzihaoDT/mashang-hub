import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_DENIAL } from '../worker/publishing/gate.mjs';
const temp = await mkdtemp(join(tmpdir(), 'publishing-bridge-'));
const repo = new URL('..', import.meta.url).pathname;
const publishRoot = join(temp, 'publish'); await mkdir(join(publishRoot, 'src'), { recursive: true });
await writeFile(join(publishRoot, 'src/cli.mjs'), `import {appendFileSync} from 'node:fs'; appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({preview:{}})); console.log(JSON.stringify({status:'PUBLISHED',idstr:'4567890123456789012'}));`);
let modelCalls = 0; let allowUnsafe = false; const created = []; const streams = new Set();
const oc = createServer(async (req,res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/event') { res.writeHead(200, {'content-type':'text/event-stream'}); res.write(': connected\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  let body=''; for await (const chunk of req) body+=chunk;
  res.setHeader('content-type','application/json');
  if (path === '/config/providers') return res.end(JSON.stringify({providers:{}}));
  if (path === '/session' && req.method === 'POST') { created.push(JSON.parse(body)); return res.end(JSON.stringify({id:'mock-session'})); }
  if (path === '/session/mock-session' && req.method === 'GET') return res.end(JSON.stringify({permission:allowUnsafe ? [] : TOOL_DENIAL}));
  if (path.endsWith('/message')) { assert.deepEqual(JSON.parse(body).tools, { '*': false }); modelCalls++; return res.end(JSON.stringify({parts:[{type:'text',text:'普通模型回答'}]})); }
  res.end('{}');
});
await new Promise(resolve => oc.listen(0,'127.0.0.1',resolve));
const hubPort = 39000 + Math.floor(Math.random()*1000); const base = `http://127.0.0.1:${hubPort}`;
const hub = spawn(process.execPath,['server.mjs'], {cwd:repo,env:{...process.env,PORT:String(hubPort),HUB_HOST:'127.0.0.1',WORKER_SECRET:'mock-secret',HUB_ACCESS_TOKEN:'mock-access',HUB_TURN_LOG:join(temp,'turns.jsonl')},stdio:['ignore','ignore','pipe']});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(predicate) { for(let i=0;i<100;i++) { const value=await predicate(); if(value)return value; await sleep(30); } throw new Error('bridge timeout'); }
let worker; let cookie=''; let reader; const events=[];
async function api(path, body) { const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined}); return {response,data:await response.json()}; }
function startWorker() {
  worker=spawn(process.execPath,['worker/worker.mjs'],{cwd:repo,env:{...process.env,HUB_URL:base,WORKER_SECRET:'mock-secret',MASHANG_SERVICE_ROOT:temp,MYKNBASE_ROOT:temp,OPENCODE_URL:`http://127.0.0.1:${oc.address().port}`,MASHANG_PUBLISH_ENABLED:'1',MASHANG_PUBLISH_ROOT:publishRoot,MASHANG_PUBLISH_GATE_DIR:join(temp,'gate'),WORKER_STATE_FILE:join(temp,'state.json'),RUNTIME_SNAPSHOT_INTERVAL_MS:'600000'},stdio:['ignore','ignore','pipe']});
}
try {
  await until(async()=>{try{return (await fetch(base+'/api/auth/status')).ok;}catch{return false;}});
  assert.equal((await api('/api/sessions',{})).response.status,401);
  const login=await api('/api/auth/login',{token:'mock-access'}); cookie=login.response.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/events',{headers:{cookie}}); reader=response.body.getReader();
  const consume=(async()=>{let buffer='';const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const records=buffer.split('\n\n');buffer=records.pop();for(const record of records){const data=record.split('\n').find(l=>l.startsWith('data:'));if(data)events.push(JSON.parse(data.slice(5)));}}}catch{}})();
  startWorker(); await until(async()=> (await api('/api/health')).data.connected);
  const session=(await api('/api/sessions',{title:'mock'})).data;
  async function turn(text, confirmationId, extra={}) {
    const {data}=await api(`/api/sessions/${session.id}/message`,{parts:[{type:'text',text}],model:{providerID:'mock',modelID:'mock'},confirmationId,...extra});
    await until(()=>events.find(e=>e.taskId===data.taskId && ['task.completed','task.failed'].includes(e.type)));
    return events.find(e=>e.taskId===data.taskId && e.type==='agent.message.completed') || events.find(e=>e.taskId===data.taskId && e.type==='task.failed');
  }
  const body='mock 中文 " $() `echo`\n第二行';
  const preview=await turn('把这段文字发布到微博：'+body,undefined,{actor:{kind:'agent',authenticated:false}});
  assert.match(preview.text,/尚未发布/); assert.equal(modelCalls,0);
  assert.match((await turn('确认发布')).text,/没有绑定/);
  const result=await turn('确认发布',preview.confirmationId); assert.match(result.text,/4567890123456789012/);
  await turn('确认发布',preview.confirmationId);
  assert.equal((await readFile(join(publishRoot,'calls.jsonl'),'utf8')).trim().split('\n').length,1);
  const args=JSON.parse((await readFile(join(publishRoot,'calls.jsonl'),'utf8')).trim());assert.equal(args[2],body);
  const exit = new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGTERM');await exit;
  await until(async()=>!(await api('/api/health')).data.connected);startWorker();await until(async()=>(await api('/api/health')).data.connected);
  assert.match((await turn('确认发布',preview.confirmationId)).text,/发布成功/);
  assert.equal((await readFile(join(publishRoot,'calls.jsonl'),'utf8')).trim().split('\n').length,1);
  // Cancel an already launched Mock CLI; neither cancellation nor restart retries it.
  await writeFile(join(publishRoot,'src/cli.mjs'), `import {appendFileSync} from 'node:fs'; appendFileSync('calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n'); setTimeout(()=>console.log(JSON.stringify({status:'PUBLISHED',idstr:'999'})),10000);`);
  const cancelPreview = await turn('发布微博：mock cancel in flight');
  const inFlight = (await api(`/api/sessions/${session.id}/message`,{parts:[{type:'text',text:'确认发布'}],model:{providerID:'mock',modelID:'mock'},confirmationId:cancelPreview.confirmationId})).data;
  await until(async()=>{try{return (await readFile(join(publishRoot,'calls.jsonl'),'utf8')).trim().split('\n').length===2;}catch{return false;}});
  assert.ok(events.some(e=>e.taskId===inFlight.taskId && e.externalEffectPossible));
  await api(`/api/tasks/${inFlight.taskId}/cancel`,{});
  await until(()=>events.some(e=>e.taskId===inFlight.taskId && ['task.completed','task.cancelled'].includes(e.type)));
  assert.match(events.find(e=>e.taskId===inFlight.taskId && e.type==='agent.message.completed').text,/UNCERTAIN/);
  const cancelExit=new Promise(resolve=>worker.once('exit',resolve));worker.kill('SIGTERM');await cancelExit;
  await until(async()=>!(await api('/api/health')).data.connected);startWorker();await until(async()=>(await api('/api/health')).data.connected);
  assert.match((await turn('确认发布',cancelPreview.confirmationId)).text,/UNCERTAIN/);
  assert.equal((await readFile(join(publishRoot,'calls.jsonl'),'utf8')).trim().split('\n').length,2);
  await turn('普通问题');assert.equal(modelCalls,1);assert.deepEqual(created[0].permission,TOOL_DENIAL);
  allowUnsafe=true;const denied=await turn('尝试用工具发布');assert.match(denied.error,/GUARD_UNVERIFIED/);assert.equal(modelCalls,1);
  const logs=await readFile(join(temp,'turns.jsonl'),'utf8');assert.equal(logs.includes(body),false);assert.equal(logs.includes('mock-secret'),false);
  console.log('Authenticated Hub → Worker → Mock CLI, restart and OpenCode guard checks passed');
} finally {
  worker?.kill('SIGTERM');hub.kill('SIGTERM');await reader?.cancel();for(const stream of streams)stream.end();oc.closeAllConnections();await new Promise(resolve=>oc.close(resolve));
}
