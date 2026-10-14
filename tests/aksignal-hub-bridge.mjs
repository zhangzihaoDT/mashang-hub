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
const mock = createServer((req, res) => {
  if (req.method === 'POST') agentCalls++;
  if (req.url.startsWith('/global/event')) { res.writeHead(200, {'content-type':'text/event-stream'}); res.write(': heartbeat\n\n'); return; }
  res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({providers:{}}));
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
  await page.waitForSelector('#businessRuntime [data-op="run"]');
  assert.equal(await page.locator('.workspace-tab').count(),5);
  assert.equal(await page.locator('#conversationWorkspace').isVisible(),false);
  assert.equal(await page.locator('#independentWorkspace').isVisible(),false);
  assert.match(await page.locator('#businessRuntime').textContent(),/data_complete=false/);
  assert.match(await page.locator('#businessRuntime').textContent(),/124\/124/);
  await page.locator('#businessRuntime [data-op="run"]').click();
  await page.waitForSelector('#businessRuntime [data-decision="approve"]');
  await page.locator('#businessRuntime [data-decision="approve"]').click();
  await until(async()=> (await (await fetch(base+'/api/runtime/controls')).json()).some(c=>c.targetId==='aksignal-daily' && c.status==='COMPLETED'),'manual tick acknowledgement');
  assert.deepEqual(await readFile(receipt),before,'manual existing tick did not republish');
  const record=JSON.parse(await readFile(join(fixture,'.run_day/scheduler',td+'.json'),'utf8'));
  assert.equal(record.attempts,0,'existing published fixture does not start any calculation');
  assert.equal(record.status,'published');
  await page.locator('#businessRuntime [data-refresh]').click();
  await mkdir(join(root,'screenshots'));
  await page.evaluate(()=>document.querySelector('#businessRuntime').scrollTop=0);
  assert.equal(await page.locator('.business-batch h2').isVisible(),true);
  await page.screenshot({path:join(root,'screenshots/desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.querySelector('#businessRuntime').scrollTop=0);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.topbar').count(),1);
  await page.screenshot({path:join(root,'screenshots/mobile.png'),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no mobile horizontal overflow');
  assert.deepEqual(errors,[]);
  assert.equal(agentCalls,0,'no OpenCode Agent calls for the domain operation');
  console.log('PASS: fifth domain, real Worker/Python read-only provider, native tick dedupe, SHA256 downloads, quality, mobile, no Agent');
  console.log('Screenshots:',join(root,'screenshots'));
} catch(error) { console.error(logs.join('\n')); throw error; }
finally {
  await browser?.close();worker?.kill('SIGTERM');hub?.kill('SIGTERM');
  mock.closeAllConnections();await new Promise(r=>mock.close(r));
  // Keep screenshots/evidence in /tmp for visual review; processes always stop.
}
