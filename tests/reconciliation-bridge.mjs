import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const port=44000+Math.floor(Math.random()*2000),base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,taskCreate,reportRequest;
const hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),HUB_HOST:'127.0.0.1',HUB_TASK_DB:':memory:',HUB_ACCESS_TOKEN:'',WORKER_SECRET:'test',TASK_CANCEL_GRACE_MS:'80'},stdio:'ignore'});
async function api(path,data){const res=await fetch(base+path,{method:data?'POST':'GET',headers:{'content-type':'application/json'},body:data?JSON.stringify(data):undefined});assert.ok(res.ok);return res.json();}
async function until(fn){for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await sleep(30);}throw Error('Timeout');}
async function connect(){ws=new WebSocket(base.replace('http:','ws:')+'/worker',{headers:{Authorization:'Bearer test'}});await once(ws,'open');ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='task.create')taskCreate=m;if(m.type==='worker.reconcile.request')reportRequest=m;});ws.send(JSON.stringify({type:'worker.register',workerId:'worker1',taskProtocolVersion:1,models:[]}));await sleep(70);}
function send(m){ws.send(JSON.stringify(m));}
try{
 await until(async()=>await api('/api/health'));await connect();
 const session=await api('/api/sessions',{});
 const task=await api(`/api/sessions/${session.id}/message`,{parts:[{type:'text',text:'mock'}],policy:{executionDeadlineMs:10000,progressTimeoutMs:100}});
 await until(()=>taskCreate);
 const identity={taskId:task.taskId,attemptId:taskCreate.attemptId,dispatchId:taskCreate.dispatchId};
 send({type:'task.running',...identity});await until(async()=>(await api(`/api/tasks/${task.taskId}`)).status==='RUNNING');
 const progress=(await api(`/api/tasks/${task.taskId}`)).lastProgressAt;
 send({type:'worker.heartbeat',workerId:'worker1'});await sleep(120);
 assert.equal((await api(`/api/tasks/${task.taskId}`)).lastProgressAt,progress,'heartbeat cannot refresh task progress');
 send({type:'task.failed',...identity,attemptId:'stale'});await sleep(50);assert.equal((await api(`/api/tasks/${task.taskId}`)).status,'RUNNING');
 send({type:'task.cancelled',...identity,source:'timeout'});
 await until(async()=>(await api(`/api/tasks/${task.taskId}`)).status==='INTERRUPTED');
 assert.equal((await api(`/api/tasks/${task.taskId}`)).reason,'CANCEL_UNVERIFIED','old cancellation without stop proof cannot settle the task');
 ws.close();await until(async()=>(await api(`/api/tasks/${task.taskId}`)).status==='INTERRUPTED');
 await api(`/api/tasks/${task.taskId}/cancel`,{});assert.equal((await api(`/api/tasks/${task.taskId}`)).cancelRequested,true);
 await connect();await until(()=>reportRequest);
 send({type:'worker.reconcile',workerId:'worker1',records:[{...identity,attemptId:'stale',state:'RUNNING'}]});await sleep(50);assert.equal((await api(`/api/tasks/${task.taskId}`)).status,'INTERRUPTED');
 send({type:'worker.reconcile',workerId:'worker1',records:[{...identity,state:'RESULT',events:[{type:'agent.message.completed',...identity,text:'finished before cancellation'},{type:'task.completed',...identity}]}]});
 await until(async()=>(await api(`/api/tasks/${task.taskId}`)).status==='COMPLETED');
 send({type:'task.failed',...identity});await sleep(50);assert.equal((await api(`/api/tasks/${task.taskId}`)).status,'COMPLETED');
 console.log('Heartbeat separation, stale-attempt refusal, offline cancellation and durable result reconciliation passed');
}finally{ws?.terminate();if(hub.exitCode===null){const exited=once(hub,'exit');hub.kill('SIGKILL');await exited;}}
