import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'hub-long-task-'));
const duration = Number(process.env.LONG_TASK_MS || 6000);
const port = 42000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const streams = new Set(); let calls = 0, hub, worker, output = '';
const oc = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/event') { res.writeHead(200, {'content-type':'text/event-stream'}); res.write(': ready\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  for await (const chunk of req) {} // consume input
  res.setHeader('content-type', 'application/json');
  if (path === '/config/providers') return res.end(JSON.stringify({ providers: {} }));
  if (path === '/session') return res.end(JSON.stringify({ id: 'mock-session' }));
  if (path.endsWith('/message')) {
    calls++;
    const progress = setInterval(() => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: 'message.part.updated', properties: { part: { sessionID: 'mock-session' } } })}\n\n`); }, 1000);
    await sleep(duration); clearInterval(progress);
    return res.end(JSON.stringify({ parts: [{type:'text',text:'Long task finished'}], info:{providerID:'mock',modelID:'mock'} }));
  }
  res.end('{}');
});
await new Promise(resolve => oc.listen(0, '127.0.0.1', resolve));
async function api(path, data) { const res = await fetch(base + path, { method: data ? 'POST' : 'GET', headers:{'content-type':'application/json'}, body:data ? JSON.stringify(data):undefined }); assert.ok(res.ok, `${path}: ${res.status}`); return res.json(); }
async function until(predicate, timeout = 10000) { const end=Date.now()+timeout; while(Date.now()<end){try {const result=await predicate();if(result)return result;}catch{} await sleep(50);} throw new Error(`Timeout\n${output.slice(-4000)}`); }
function startHub() {
  hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,HUB_HOST:'127.0.0.1',PORT:String(port),HUB_TASK_DB:join(directory,'tasks.sqlite'),HUB_TURN_LOG:join(directory,'turns.jsonl'),HUB_ACCESS_TOKEN:'',WORKER_SECRET:'mock-secret',TASK_TIMEOUT_MS:'300',TASK_PROGRESS_TIMEOUT_MS:'1500'},stdio:['ignore','pipe','pipe']});
  hub.stdout.on('data', data=>output+=data); hub.stderr.on('data', data=>output+=data);
}
async function stop(child) { if(child?.exitCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;} }
try {
  startHub(); await until(async()=> (await api('/api/health')));
  worker=spawn(process.execPath,['worker/worker.mjs'],{env:{...process.env,HUB_URL:base,WORKER_SECRET:'mock-secret',MASHANG_SERVICE_ROOT:directory,MYKNBASE_ROOT:directory,OPENCODE_URL:`http://127.0.0.1:${oc.address().port}`,WORKER_STATE_FILE:join(directory,'worker.json'),MASHANG_PUBLISH_ENABLED:'0',WORKER_HEARTBEAT_MS:'200',RUNTIME_SNAPSHOT_INTERVAL_MS:'600000'},stdio:['ignore','pipe','pipe']});
  worker.stdout.on('data', data=>output+=data);worker.stderr.on('data',data=>output+=data);
  await until(async()=> (await api('/api/health')).worker?.id);
  const session=await api('/api/sessions',{title:'long'});
  const task=await api(`/api/sessions/${session.id}/message`,{model:{providerID:'mock',modelID:'mock'},parts:[{type:'text',text:'long'}],policy:{executionDeadlineMs:duration+15000,progressTimeoutMs:1500}});
  await until(async()=> (await api(`/api/tasks/${task.taskId}`)).status==='RUNNING');
  const before=await api(`/api/tasks/${task.taskId}`);
  await sleep(400); assert.equal((await api(`/api/tasks/${task.taskId}`)).status,'RUNNING', 'task policy must override legacy timeout');
  await stop(hub);startHub();await until(async()=> (await api('/api/health')));
  await until(async()=> ['RUNNING','COMPLETED'].includes((await api(`/api/tasks/${task.taskId}`)).status));
  const after=await api(`/api/tasks/${task.taskId}`);
  assert.equal(before.dispatchId,after.dispatchId);assert.equal(before.attemptId,after.attemptId);
  await until(async()=> (await api(`/api/tasks/${task.taskId}`)).status==='COMPLETED',duration+20000);
  assert.equal(calls,1,'Hub restart / Worker reconnect must not call OpenCode twice');
  assert.equal((await api(`/api/tasks/${task.taskId}`)).hasText,true);
  console.log(`Real Hub + Worker + Mock OpenCode: ${duration}ms execution, Hub restart, reconnect, one invocation, COMPLETED`);
} finally { await stop(worker);await stop(hub);for(const stream of streams)stream.destroy();oc.closeAllConnections();await new Promise(resolve=>oc.close(resolve));rmSync(directory,{recursive:true,force:true}); }
