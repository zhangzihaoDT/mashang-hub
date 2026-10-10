import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temp=mkdtempSync(join(tmpdir(),'hub-ui-'));
const port=47000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,worker;const tasks=[],errors=[];
const hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port),HUB_HOST:'127.0.0.1',HUB_TASK_DB:':memory:',HUB_TURN_LOG:join(temp,'turns.jsonl'),HUB_ACCESS_TOKEN:'',WORKER_SECRET:'ui-mock'},stdio:'ignore'});
async function until(fn){for(let i=0;i<100;i++){try{const value=await fn();if(value)return value;}catch{}await sleep(30);}throw Error('UI fixture did not start');}
function send(message){worker.send(JSON.stringify(message));}
try{
 await until(async()=> (await fetch(base+'/api/health')).ok);
 worker=new WebSocket(base.replace('http:','ws:')+'/worker',{headers:{Authorization:'Bearer ui-mock'}});await once(worker,'open');
 worker.on('message',raw=>{
  const message=JSON.parse(raw);
  if(message.type==='task.create'){
   tasks.push(message);send({type:'task.running',taskId:message.taskId,sessionId:message.sessionId});
   setTimeout(()=>{
    send({type:'artifact.created',taskId:message.taskId,artifactId:'artifact-'+tasks.length,name:'报告.md',extension:'.md',mimeType:'text/markdown',artifactType:'markdown',size:120});
    send({type:'agent.message.completed',taskId:message.taskId,sessionId:message.sessionId,text:message.prompt.includes('起草与审阅')?'## 内容草稿\n\n这是供审阅的 Mock 草稿。':'## 分析结论\n\nMock 分析完成。\n\n| 指标 | 结果 |\n| --- | --- |\n| 任务 | 完成 |'});
    send({type:'task.completed',taskId:message.taskId,sessionId:message.sessionId});
   },600);
  }
  if(message.type==='artifact.request')send({type:'artifact.response',requestId:message.requestId,artifactId:message.artifactId,filename:'报告.md',contentType:'text/markdown; charset=utf-8',contentBase64:Buffer.from('# 附件预览\n\n来自 Mock Worker 的报告。').toString('base64')});
 });
 send({type:'worker.register',workerId:'ui-worker',models:[{key:'deepseek',providerID:'mock',modelID:'mock',label:'Mock model',available:true}],workspaces:[]});
 send({type:'runtime.snapshot',protocolVersion:1,workerId:'ui-worker',sequence:1,generatedAt:new Date().toISOString(),dependencies:[],services:[{id:'fetch',label:'Fetch',status:'ONLINE',openUrl:'https://fetch.example.test/'},{id:'myknbase',label:'Knbase',status:'ONLINE',openUrl:'http://127.0.0.1:4317/'}],jobs:[],operations:[]});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 assert.equal(await page.locator('.workspace-tab').count(),4);
 await page.locator('#prompt').fill('保留 Service 草稿');
 await page.locator('[data-workspace="fetch"]').click();assert.equal(await page.locator('#independentWorkspace').isVisible(),true);assert.equal(await page.locator('#conversationWorkspace').isVisible(),false);
 assert.equal(await page.locator('#independentOpen').getAttribute('href'),'https://fetch.example.test/');
 await page.locator('[data-workspace="knbase"]').click();assert.match(await page.locator('#independentHint').textContent(),/本机地址/);
 await page.locator('[data-workspace="publish"]').click();assert.equal(await page.locator('#workspaceNotice').isVisible(),true);assert.equal(await page.locator('#prompt').inputValue(),'');
 await page.locator('#prompt').fill('保留 Publish 草稿');await page.locator('[data-workspace="service"]').click();assert.equal(await page.locator('#prompt').inputValue(),'保留 Service 草稿');assert.equal(tasks.length,0,'navigation must never execute a task');
 await page.locator('#prompt').fill('分析测试问题');await page.locator('#send').click();await until(()=>tasks.length===1);
 await page.locator('[data-workspace="publish"]').click();await sleep(850);assert.ok(!(await page.locator('#resultContent').textContent()).includes('Mock 分析完成'),'inactive task result must not leak into Publish');
 assert.equal(await page.locator('#prompt').inputValue(),'保留 Publish 草稿');await page.locator('#send').click();await until(()=>tasks.length===2);await sleep(850);
 assert.ok(tasks[1].prompt.includes('只生成或修改文字，不执行发布'));assert.notEqual(tasks[0].sessionId,tasks[1].sessionId);
 await page.locator('[data-workspace="service"]').click();assert.match(await page.locator('#resultContent').textContent(),/Mock 分析完成/);assert.equal(await page.locator('#resultContent table').count(),1);
 await page.locator('[data-action="preview"]').click();await page.waitForSelector('.artifact-markdown');assert.match(await page.locator('.artifact-markdown').textContent(),/附件预览/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 mkdirSync('.local/ui-preview',{recursive:true});await page.screenshot({path:'.local/ui-preview/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);await page.screenshot({path:'.local/ui-preview/mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile must not overflow horizontally');
 await page.locator('[data-workspace="fetch"]').click();await page.screenshot({path:'.local/ui-preview/fetch.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('Browser UI passed: four workspaces, selection without execution, isolated drafts/sessions/results, independent links, Markdown attachment preview, desktop/mobile layout');
}finally{await browser?.close();worker?.terminate();if(hub.exitCode===null){const exit=once(hub,'exit');hub.kill('SIGKILL');await exit;}rmSync(temp,{recursive:true,force:true});}
