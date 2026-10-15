import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
const port=Number(process.env.PREVIEW_TEST_PORT || 38274),base=`http://127.0.0.1:${port}`;
const content=process.env.PREVIEW_TEST_REPORT ? await readFile(process.env.PREVIEW_TEST_REPORT) : Buffer.from(`<!doctype html><button id="test">Increment</button><output id="count">0</output><div id="isolation"></div><script>let n=0;document.querySelector('#test').onclick=()=>document.querySelector('#count').textContent=String(++n);let opaque=false;try{sessionStorage.setItem('test','x')}catch{opaque=true}fetch('/api/health').then(()=>document.querySelector('#isolation').textContent='FAIL').catch(()=>document.querySelector('#isolation').textContent=opaque?'ISOLATED':'FAIL');</script>`);
const id='runtime_'+createHash('sha256').update(content).digest('hex');
const hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,HUB_HOST:'127.0.0.1',PORT:String(port),HUB_TASK_DB:':memory:',HUB_TURN_LOG:'/private/tmp/artifact-preview-test.jsonl',WORKER_SECRET:'isolated-preview-test',HUB_ACCESS_TOKEN:''},stdio:['ignore','ignore','pipe']});
let ws,heartbeat;let errors='';hub.stderr.on('data',b=>errors+=b);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<80;i++){try{const v=await fn();if(v)return v;}catch{}await sleep(100);}throw Error('preview test timeout '+errors);}
async function cleanup(){clearInterval(heartbeat);ws?.close();hub.kill();}
try {
 await until(async()=>(await fetch(base+'/api/health')).ok);
 ws=new WebSocket(`ws://127.0.0.1:${port}/worker`,{headers:{Authorization:'Bearer isolated-preview-test'}});
 await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject)});
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='artifact.request')ws.send(JSON.stringify({type:'artifact.response',requestId:m.requestId,contentType:'text/html; charset=utf-8',filename:'report.html',contentBase64:content.toString('base64')}));});
 ws.send(JSON.stringify({type:'worker.register',workerId:'preview-test',status:'ONLINE',models:[]}));
 ws.send(JSON.stringify({type:'artifact.created',artifactId:id,workerId:'preview-test',extension:'.html',name:'report.html',digest:createHash('sha256').update(content).digest('hex'),size:content.length}));
 const url=base+'/api/artifacts/content?artifactId='+id;
 const response=await until(async()=>{const r=await fetch(url);return r.ok?r:null;});
 assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts allow-downloads/);
 assert.match(response.headers.get('content-security-policy'),/script-src 'sha256-/);
 assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
 assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),content);
 const download=await fetch(base+'/api/artifacts/download?artifactId='+id);
 assert.equal(download.headers.get('content-security-policy'),null);
 assert.match(download.headers.get('content-disposition'),/^attachment/);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),content);
 console.log('Actual Hub artifact route: hashed sandbox preview and unchanged download passed');
 if(process.argv.includes('--serve')) {
  console.log('PREVIEW_URL='+url);
  heartbeat=setInterval(()=>ws.send(JSON.stringify({type:'worker.heartbeat',workerId:'preview-test',status:'ONLINE'})),10000);
  await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }
}finally{await cleanup();}
