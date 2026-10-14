import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readJsonOperation } from '../worker/runtime/json-operation.mjs';

// Opt-in integration: supplied isolated current formal release; never production caches.
const fixture = process.env.AKSIGNAL_TEST_ROOT;
if (!fixture || !fixture.startsWith('/private/tmp/')) throw Error('AKSIGNAL_TEST_ROOT must be an isolated /private/tmp fixture');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(join(tmpdir(), 'aksignal-hub-bridge-'));
let agentCalls = 0, browser, worker, hub;
const talkRequests=[];
const mock = createServer(async (req, res) => {
  let body='';for await (const chunk of req) body+=chunk;
  const input=body ? JSON.parse(body) : {};
  req.url=req.url.split('?')[0];
  if(req.method==='POST') agentCalls++;
  if(req.url.startsWith('/global/event')) {res.writeHead(200,{'content-type':'text/event-stream'});res.write(': heartbeat\n\n');return;}
  let value={providers:{}};
  if(req.url==='/session' && req.method==='POST') {talkRequests.push({kind:'session',input});value={id:'talk-session',permission:input.permission};}
  else if(req.url==='/session/talk-session' && req.method==='GET') value={id:'talk-session',permission:[{permission:'*',pattern:'*',action:'deny'}]};
  else if(req.url==='/session/talk-session/message' && req.method==='POST') {talkRequests.push({kind:'message',input});value={info:{providerID:'deepseek',modelID:'test-model'},parts:[{type:'text',text:'测试回答：本期数据不完整，复权限制保留。'}]};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const mockURL = `http://127.0.0.1:${mock.address().port}`;
const port = 36000 + Math.floor(Math.random()*3000), base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const logs = [];
async function until(fn, label) { for(let i=0;i<120;i++){try{const value=await fn();if(value)return value;}catch{}await sleep(100);}throw Error(label); }
try {
  const view = await readJsonOperation({command:join(fixture,'.venv/bin/python'), args:['-m','src.daily_hub'],cwd:fixture,artifactRoot:join(fixture,'.run_day/runs')});
  assert.equal(view.lastRun.status,'PUBLISHED','fixture must have current target formally published; no fresh online run is allowed');
  assert.equal(view.details.targetDate,view.details.publication.trade_date);
  const td = view.details.targetDate, receipt = join(fixture,'outputs/run_day/publication.json');
  const before = await readFile(receipt);
  const config = join(root,'runtime.json');
  await writeFile(config,JSON.stringify({services:[
    {id:'fetch',probe:{type:'http',url:mockURL}}, {id:'myknbase',probe:{type:'http',url:mockURL}},
    {id:'scheduler',probe:{type:'process',match:'nonexistent-integration-scheduler'},match:'nonexistent-integration-scheduler'}],
    dependencies:[{id:'opencode',probe:{type:'http',url:mockURL}}],operations:[{id:'daily',enabled:false},{id:'allupdate',enabled:false}]}));
  hub=spawn(process.execPath,['server.mjs'],{env:{...process.env,HUB_HOST:'127.0.0.1',PORT:String(port),HUB_TASK_DB:':memory:',HUB_TURN_LOG:join(root,'turns.jsonl'),HUB_ACCESS_TOKEN:'',WORKER_SECRET:'isolated-test'},stdio:['ignore','pipe','pipe']});
  hub.stderr.on('data',d=>logs.push(String(d)));
  await until(async()=> (await fetch(base+'/api/health')).ok,'local Hub startup');
  worker=spawn(process.execPath,['worker/worker.mjs'],{env:{...process.env,HUB_URL:base,WORKER_SECRET:'isolated-test',WORKER_ID:'isolated-worker',MASHANG_SERVICE_ROOT:root,MASHANG_AKSIGNAL_ROOT:fixture,MASHANG_RUNTIME_CONFIG:config,OPENCODE_URL:mockURL,WORKER_STATE_FILE:join(root,'worker.json'),WORKER_EXECUTION_JOURNAL:join(root,'journal.json'),MASHANG_RUNTIME_DIR:join(root,'runtime'),MASHANG_PUBLISH_ENABLED:'0',MASHANG_PUBLISH_DIRECT:'0',MASHANG_PUBLISH_SERVICE_URL:'',RUNTIME_SNAPSHOT_INTERVAL_MS:'500',PYTHONPATH:join(fixture,'guard')},stdio:['ignore','pipe','pipe']});
  worker.stderr.on('data',d=>logs.push(String(d)));
  // Drain stdout so probes/status logs cannot block the test process.
  worker.stdout.on('data',()=>{});hub.stdout.on('data',()=>{});
  const operation=await until(async()=> (await (await fetch(base+'/api/runtime')).json()).snapshot?.operations?.find(o=>o.id==='aksignal-daily'),'registered operation');
  assert.equal(operation.workspace,'aksignal');
  assert.equal(operation.lastRun.status,'PUBLISHED');
  assert.equal(operation.details.quality.data_complete,false);
  assert.equal(operation.artifacts.length,2);
  assert.ok(!JSON.stringify(operation).includes(fixture),'no local filesystem path crosses Hub');
  for(const a of operation.artifacts){
    for(const mode of ['content','download']){
      const response=await fetch(`${base}/api/artifacts/${mode}?artifactId=${a.artifactId}`);
      assert.equal(response.status,200);
      const bytes=Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'),a.digest);
      if(a.extension==='.html' && mode==='content') assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
    }
  }
  browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.locator('[data-workspace="aksignal"]').click();
  await page.waitForSelector('#conversationRuntime [data-op="run"]',{state:'attached'});
  assert.equal(await page.locator('.workspace-tab').count(),5);
  assert.equal(await page.locator('#conversationWorkspace').isVisible(),true);
  assert.equal(await page.locator('#send').isDisabled(),true);
  await page.locator('.workspace-runtime > summary').first().click();
  assert.equal(await page.locator('#independentWorkspace').isVisible(),false);
  assert.match(await page.locator('#conversationRuntime').textContent(),/数据不完整/);
  assert.match(await page.locator('#conversationRuntime').textContent(),/124\/124/);
  await page.waitForFunction(()=>document.querySelectorAll('.business-summary article').length===3);
  assert.match(await page.locator('.business-summary').textContent(), /固定池|趋势分|股票/);
  await page.locator('[data-market-question]').first().click();
  await page.locator('#conversationRuntime [data-refresh]').click();
  await page.getByRole('status').filter({hasText:'状态已更新'}).waitFor();
  assert.equal(await page.locator('#prompt').inputValue(),'概括本期市场方向与趋势');
  await page.locator('#conversationRuntime [data-op="run"]').click();
  await page.waitForSelector('#conversationRuntime [data-decision="approve"]');
  await page.locator('#conversationRuntime [data-decision="approve"]').click();
  await until(async()=> (await (await fetch(base+'/api/runtime/controls')).json()).some(c=>c.targetId==='aksignal-daily' && c.status==='COMPLETED'),'manual tick acknowledgement');
  assert.deepEqual(await readFile(receipt),before,'manual existing tick did not republish');
  const record=JSON.parse(await readFile(join(fixture,'.run_day/scheduler',td+'.json'),'utf8'));
  assert.equal(record.attempts,0,'existing published fixture does not start any calculation');
  assert.equal(record.status,'published');
  await page.locator('#conversationRuntime [data-refresh]').click();
  await mkdir(join(root,'screenshots'));
  await page.evaluate(()=>document.querySelector('.task-scroll').scrollTop=0);
  assert.equal(await page.locator('.business-batch h2').isVisible(),true);
  await page.screenshot({path:join(root,'screenshots/desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.querySelector('.task-scroll').scrollTop=0);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.topbar').count(),1);
  await page.screenshot({path:join(root,'screenshots/mobile.png'),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no mobile horizontal overflow');
  assert.deepEqual(errors,[]);
  assert.equal(agentCalls,0,'no OpenCode Agent calls for the domain operation');
  const session=await (await fetch(base+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'market-talk-test'})})).json();
  const response=await fetch(`${base}/api/sessions/${session.id}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:'deepseek',modelID:'test-model'},workspaceId:'aksignal',marketArtifactId:operation.artifacts.find(a=>a.extension==='.html').artifactId,parts:[{type:'text',text:'解释市场方向和质量限制'}]})});
  assert.equal(response.status,202);const sent=await response.json();await until(()=>talkRequests.find(r=>r.kind==='message'),'read-only discussion dispatched');
  const request=talkRequests.find(r=>r.kind==='message').input;
  assert.deepEqual(request.tools,{'*':false});assert.deepEqual(talkRequests.find(r=>r.kind==='session').input.permission,[{permission:'*',pattern:'*',action:'deny'}]);
  assert.equal(request.model.modelID,'test-model');assert.match(request.parts[0].text,/price_basis_verified=false|复权/);assert.match(request.parts[0].text,/dc0f457e0cde4b689fb85e50beb33f46/);assert.match(request.parts[0].text,/data_complete/);assert.ok(!request.parts[0].text.includes(fixture));
  await until(async()=> (await (await fetch(base+'/api/tasks')).json()).some(t=>t.taskId===sent.taskId && ['RESULT','COMPLETED'].includes(t.status)),'read-only response completed');
  console.log('PASS: model selection, pinned full report, quality, all tools denied, conversation response');

  console.log('PASS: fifth domain, real Worker/Python read-only provider, native tick dedupe, SHA256 downloads, quality, mobile, no Agent for tick');
  console.log('Screenshots:',join(root,'screenshots'));
} catch(error) { console.error(logs.join('\n')); throw error; }
finally {
  await browser?.close();worker?.kill('SIGTERM');hub?.kill('SIGTERM');
  mock.closeAllConnections();await new Promise(r=>mock.close(r));
  // Keep screenshots/evidence in /tmp for visual review; processes always stop.
}
