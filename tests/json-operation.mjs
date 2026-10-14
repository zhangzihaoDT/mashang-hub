import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonOperation } from '../worker/runtime/json-operation.mjs';
import { operationDetails, operationArtifacts } from '../server/operation-details.mjs';
import { executeControl } from '../worker/runtime/control.mjs';
import { buildRegistry } from '../worker/runtime/registry.mjs';

const root = await mkdtemp(join(tmpdir(), 'hub-json-op-'));
try {
  const content = '<h1>formal facts</h1>', file = join(root, 'report.html');
  await writeFile(file, content);
  const payload = { lastRun: { status: 'PUBLISHED' }, details: { targetDate: '20261013',
    quality: { data_complete: false, warnings: ['price_basis_verified=false'], errors: [] },
    publication: { run_id: 'r1', trade_date: '20261013' }, password: 'not-public' },
    artifacts: [{ file, name: 'report.html', extension: '.html', size: Buffer.byteLength(content),
      digest: createHash('sha256').update(content).digest('hex'), runId: 'r1', targetDate: '20261013' }] };
  const spec = () => ({ command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`], cwd: root, artifactRoot: root });
  let registered = [];
  const v = await readJsonOperation(spec(), { onArtifacts: items => { registered = items; } });
  assert.equal(v.lastRun.status, 'PUBLISHED');
  assert.equal(registered.length, 1);
  assert.equal(operationDetails(v.details).quality.data_complete, false);
  assert.deepEqual(operationDetails({schedule:{enabled:false,agentStatus:'OFFLINE',missedPolicy:'manual_only',secret:'/private'}}).schedule,
    {enabled:false,agentStatus:'OFFLINE',lastCheckedAt:null,heartbeatAgeSeconds:null,nextScheduledAt:null,
      lastOccurrenceAt:null,lastOccurrenceStatus:null,lastOccurrenceTradeDate:null,manualPendingCount:0,missedPolicy:'manual_only'});
  assert.equal(JSON.stringify(operationDetails(v.details)).includes('not-public'), false);
  const metadata = operationArtifacts(v.artifacts);
  assert.equal(metadata.length, 1);
  assert.equal(JSON.stringify(metadata).includes(root), false);
  await writeFile(file, 'tampered');
  assert.equal((await readJsonOperation(spec())).lastRun.status, 'BLOCKED');
  const external = root + '-outside.html'; await writeFile(external, content);
  await rm(file); await symlink(external, file);
  assert.equal((await readJsonOperation(spec())).artifacts.length, 0);
  await rm(external);
  const op = buildRegistry({ MASHANG_AKSIGNAL_ROOT: root }).operations.find(o=>o.id==='aksignal-daily');
  assert.equal(op.workspace, 'aksignal');
  assert.deepEqual(op.run.args, ['-m','src.daily_schedule','--manual-run']);
  assert.equal(op.requestOnly, true);
  assert.equal(op.cancellationSupported, false);
  assert.ok(!op.run.args.includes('--restart'));
  const maintenance = buildRegistry({ MASHANG_AKSIGNAL_ROOT: root }).operations.find(o=>o.id==='aksignal-daily-maintenance-restart');
  assert.deepEqual(maintenance.run.args, ['-m','src.daily_schedule','--manual-run','--restart']);
  const registry = {runtimeDir:join(root,'runtime'),services:[],jobs:[],operations:[
    {id:'long-business',enabled:true,run:{command:process.execPath,args:['-e','setTimeout(()=>{},400)']}},
    {id:'short-trigger',enabled:true,requestOnly:true,run:{command:process.execPath,args:['-e','process.exit(0)']}},
    {id:'other-business',enabled:true,run:{command:process.execPath,args:['-e','process.exit(0)']}}
  ]};
  const log={log(){},warn(){}};
  const long=executeControl(registry,{op:'run',targetId:'long-business',log});
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await executeControl(registry,{op:'run',targetId:'short-trigger',log})).reason,'REQUEST_HANDLED');
  assert.equal((await executeControl(registry,{op:'run',targetId:'other-business',log})).reason,'OPERATION_BUSY');
  assert.equal((await long).status,'COMPLETED');
  assert.equal(operationDetails({timezone:'invalid-zone'}).timezone,undefined);
  assert.equal(operationDetails({quality:{warnings:['x'.repeat(2100)],errors:[]}}).quality.truncated,true);
  console.log('JSON provider: pinned hashes, scope, warnings and independent tick registry passed');
} finally { await rm(root, { recursive: true, force: true }); }
