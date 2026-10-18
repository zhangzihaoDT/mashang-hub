import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readJsonOperation } from '../worker/runtime/json-operation.mjs';

// Opt-in integration: supplied isolated current formal release; never production caches.
const fixture = process.env.AKSIGNAL_TEST_ROOT;
if (!fixture || !fixture.startsWith('/private/tmp/')) throw Error('AKSIGNAL_TEST_ROOT must be an isolated /private/tmp fixture');
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const screenshotRoot = join(process.cwd(),'.local/ui-preview/aksignal-v06-research-20261016');
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
  assert.ok(view.details.publication,'fixture must contain a verified formal report');
  assert.equal(view.details.marketSnapshot?.tradeDate,view.details.publication.trade_date);
  const targetAlreadyPublished = view.lastRun.status==='PUBLISHED' && view.details.targetDate===view.details.publication.trade_date;
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
  const comparisonUpdate=await until(async()=> (await (await fetch(base+'/api/runtime')).json()).snapshot?.operations?.find(o=>o.presentation==='inline-action'),'inline research update operation');
  assert.equal(operation.workspace,'aksignal');
  assert.equal(comparisonUpdate.enabled,true);
  if(targetAlreadyPublished) assert.equal(operation.lastRun.status,'PUBLISHED');
  assert.equal(operation.details.publication.trade_date,view.details.publication.trade_date,'formal report date remains independent from the current task date');
  assert.equal(operation.details.quality.data_complete,false);
  if(Array.isArray(operation.details.logLines)) {
    assert.ok(operation.details.logLines.length<=20);
    assert.ok(!JSON.stringify(operation.details.logLines).includes(fixture),'diagnostic logs do not expose local paths');
  }
  const dailyArtifacts=operation.artifacts.filter(a=>a.digest!==operation.details.trendComparison?.artifactDigest);
  assert.equal(dailyArtifacts.length,2);
  if(operation.details.trendComparison) assert.equal(operation.artifacts.length,3);
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
  assert.equal(await page.locator('.workspace-tab').count(),6);
  assert.equal(await page.locator('#conversationWorkspace').isVisible(),true);
  assert.equal(await page.locator('#send').isDisabled(),true);
  assert.equal(await page.locator('#aksignalRuntimeDrawer').isVisible(),false,'runtime details stay out of the research surface by default');
  assert.match(await page.locator('#aksignalRunStatus').textContent(),/任务完成|更新中|尚未运行/);
  const researchScroll=await page.locator('.task-scroll').evaluate(e=>e.scrollTop);
  await page.locator('#openAksignalRuntime').click();
  assert.equal(await page.locator('#independentWorkspace').isVisible(),false);
  assert.match(await page.locator('#conversationRuntime').textContent(),/数据不完整/);
  assert.match(await page.locator('#marketReport').textContent(),/行业趋势 · (124|128)/);
  assert.equal(await page.locator('#conversationRuntime .runtime-group').count(),2,'runtime modal has only current task and auto schedule groups');
  assert.equal(await page.locator('#conversationRuntime .runtime-diagnostics').evaluate(e=>e.open),false,'diagnostics start collapsed');
  await mkdir(screenshotRoot,{recursive:true});
  const desktopModal=await page.locator('#aksignalRuntimeDrawer').boundingBox();
  assert.ok(Math.abs(desktopModal.width-700)<=2,'desktop modal is about 700px wide');
  assert.ok(Math.abs(desktopModal.x*2+desktopModal.width-1440)<=2,'desktop modal is horizontally centered');
  assert.ok(desktopModal.y>=0 && desktopModal.y+desktopModal.height<=1050 && desktopModal.height<=760,'desktop modal fits viewport');
  await page.screenshot({path:join(screenshotRoot,'runtime-modal.png'),fullPage:false});
  await page.locator('#conversationRuntime .runtime-diagnostics > summary').click();
  assert.equal(await page.locator('#conversationRuntime').evaluate(e=>{const before=e.scrollTop;e.scrollTop=e.scrollHeight;const moved=e.scrollHeight<=e.clientHeight || e.scrollTop>before;e.scrollTop=before;return getComputedStyle(e).overflowY==='auto' && moved;}),true,'runtime content scrolls internally when needed');
  if(operation.details.logLines?.length) assert.equal(await page.locator('#conversationRuntime .runtime-log-tail').count(),1);
  await page.locator('#closeAksignalRuntime').click();
  assert.equal(await page.locator('.task-scroll').evaluate(e=>e.scrollTop),researchScroll,'closing preserves research scroll position');
  await page.waitForFunction(()=>document.querySelectorAll('.business-summary article').length===3);
  assert.match(await page.locator('.business-summary').textContent(), /趋势|ETF/);
  assert.ok([124,128].includes(await page.locator('.heat-cell').count()));
  assert.match(await page.locator('#marketReport').textContent(),/正式日报已发布/);
  assert.match(await page.locator('#marketReport').textContent(),/观察篮子/);
  assert.equal(await page.locator('#marketReport [data-op="run"]').count(),1,'Compare update is available in place');
  await page.locator('[data-heat-mode]').evaluate(e=>{window.originalHeatSelect=e;});
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('[data-heat-mode]').evaluate(e=>e===window.originalHeatSelect),true,'status snapshots preserve dropdown node');
  assert.equal(await page.locator('[data-heat-mode]').count(),1);

  await page.locator('[data-heat-mode]').selectOption('activeRatio');
  assert.match(await page.locator('.snapshot-heatmap').textContent(),/所属一级行业/);
  await page.locator('[data-heat-mode]').selectOption('change');
  await page.locator('.heat-cell').first().click();
  assert.match(await page.locator('.heat-info').textContent(),/RPS15/);
  await page.locator('[data-heat-mode]').selectOption('strength');
  assert.match(await page.locator('.breadth-chart').textContent(),/近 20 交易日 · \d+ 日已发布/);
  assert.match(await page.locator('.state-legend').textContent(),/趋势形成 \d+/);
  assert.equal(await page.locator('#toggleMarketComposer').getAttribute('aria-expanded'),'false','discussion starts compact to leave room for research');
  await page.locator('#toggleMarketComposer').click();
  await page.locator('[data-market-question]').first().click();
  await page.locator('#openAksignalRuntime').click();
  await page.locator('#conversationRuntime [data-refresh]').click();
  await page.getByRole('status').filter({hasText:'状态已更新'}).waitFor();
  if(targetAlreadyPublished) assert.equal(await page.locator('#conversationRuntime [data-op="run"][data-target="aksignal-daily"]').isDisabled(),true,'already-published target is not offered as a rerun');
  assert.equal(await page.locator('#prompt').inputValue(),'概括本期市场方向与趋势');
  if(targetAlreadyPublished) assert.equal(await page.locator('#conversationRuntime [data-op="run"][data-target="aksignal-daily"]').isDisabled(),true,'a target already formally published cannot be rerun from the UI');
  await page.locator('#conversationRuntime [data-refresh]').click();
  await page.locator('#closeAksignalRuntime').click();
  await page.locator('#toggleMarketComposer').click();
  await page.evaluate(()=>document.querySelector('.task-scroll').scrollTop=0);
  assert.equal(await page.locator('.business-batch h2').isVisible(),true);
  await page.screenshot({path:join(screenshotRoot,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.querySelector('.task-scroll').scrollTop=0);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.topbar').count(),1);
  await page.screenshot({path:join(screenshotRoot,'mobile.png'),fullPage:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no mobile horizontal overflow');
  await page.locator('#openAksignalRuntime').click();
  const mobileModal=await page.locator('#aksignalRuntimeDrawer').boundingBox();
  assert.ok(Math.abs(mobileModal.width-374)<=2,'mobile modal keeps safe side margins');
  assert.ok(Math.abs(mobileModal.x*2+mobileModal.width-390)<=2,'mobile modal is centered');
  assert.ok(Math.abs(mobileModal.y*2+mobileModal.height-844)<=2,'mobile modal is vertically centered');
  assert.ok(mobileModal.y>=0 && mobileModal.y+mobileModal.height<=844 && mobileModal.height<=844*.88+1,'mobile modal fits viewport');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'open mobile modal has no horizontal overflow');
  await page.screenshot({path:join(screenshotRoot,'runtime-modal-mobile.png'),fullPage:false});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#aksignalRuntimeDrawer').evaluate(e=>e.open),false,'ESC closes modal');
  await page.locator('#openAksignalRuntime').click();
  await page.mouse.click(1,1);
  assert.equal(await page.locator('#aksignalRuntimeDrawer').evaluate(e=>e.open),false,'backdrop closes modal');
  assert.deepEqual(errors,[]);
  assert.equal(agentCalls,0,'no OpenCode Agent calls for the domain operation');
  const session=await (await fetch(base+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'market-talk-test'})})).json();
  const response=await fetch(`${base}/api/sessions/${session.id}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:'deepseek',modelID:'test-model'},workspaceId:'aksignal',marketArtifactId:operation.artifacts.find(a=>a.extension==='.html').artifactId,parts:[{type:'text',text:'解释市场方向和质量限制'}]})});
  assert.equal(response.status,202);const sent=await response.json();await until(()=>talkRequests.find(r=>r.kind==='message'),'read-only discussion dispatched');
  const request=talkRequests.find(r=>r.kind==='message').input;
  assert.deepEqual(request.tools,{'*':false});assert.deepEqual(talkRequests.find(r=>r.kind==='session').input.permission,[{permission:'*',pattern:'*',action:'deny'}]);
  assert.equal(request.model.modelID,'test-model');assert.match(request.parts[0].text,/price_basis_verified=false|复权/);assert.ok(request.parts[0].text.includes(operation.details.publication.run_id));assert.match(request.parts[0].text,/data_complete/);assert.ok(!request.parts[0].text.includes(fixture));
  await until(async()=> (await (await fetch(base+'/api/tasks')).json()).some(t=>t.taskId===sent.taskId && ['RESULT','COMPLETED'].includes(t.status)),'read-only response completed');
  console.log('PASS: model selection, pinned full report, quality, all tools denied, conversation response');

  console.log('PASS: AKsignal workspace, real Worker/Python read-only provider, status separation, report artifacts, quality, mobile, no Agent for domain operation');
  console.log('Screenshots:',screenshotRoot);
} catch(error) { console.error(logs.join('\n')); throw error; }
finally {
  await browser?.close();worker?.kill('SIGTERM');hub?.kill('SIGTERM');
  mock.closeAllConnections();await new Promise(r=>mock.close(r));
  // Keep screenshots/evidence in /tmp for visual review; processes always stop.
}
