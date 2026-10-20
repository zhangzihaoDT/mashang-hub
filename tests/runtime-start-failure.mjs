import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeControl } from '../worker/runtime/control.mjs';
const root = await mkdtemp(join(tmpdir(), 'start-failure-'));
const log = { log() {}, warn() {} };
const service = { id: 'test', probe: { type: 'http', url: 'http://127.0.0.1:1' }, control: { start: { command: process.execPath, args: ['-e', 'process.exit(7)'], detach: true } } };
const registry = { services: [service], runtimeDir: root, verifyMs: 2000, probeTimeoutMs: 100 };
try {
  const started = Date.now();
  assert.deepEqual(await executeControl(registry, { op: 'up', targetId: 'test', log }), { status: 'FAILED', reason: 'EXEC_FAILED', code: 7 });
  assert.ok(Date.now() - started < 1800);
  service.control.start.command = join(root, 'missing');
  assert.deepEqual(await executeControl(registry, { op: 'up', targetId: 'test', log }), { status: 'FAILED', reason: 'EXEC_FAILED', code: null });
  service.control.start.command = process.execPath;
  service.control.start.args = ['-e', 'setTimeout(()=>{},900)'];
  registry.verifyMs = 150;
  assert.equal((await executeControl(registry, { op: 'up', targetId: 'test', log })).reason, 'UNVERIFIED');
  console.log('Runtime start failure checks passed');
} finally { await rm(root, { recursive: true, force: true }); }
