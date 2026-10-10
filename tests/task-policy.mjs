import assert from 'node:assert/strict';
import { executionPolicy, executionTimes } from '../server/task-policy.mjs';
const policy = executionPolicy({}, {});
assert.equal(policy.executionDeadlineMs, 900000);
assert.equal(policy.progressTimeoutMs, 180000);
assert.equal(executionTimes({policy,startedAt:1000,lastProgressAt:1000},182000).stalled,true);
assert.ok(executionTimes({policy,startedAt:1000,lastProgressAt:181000},182000).remainingMs>0);
assert.equal(executionTimes({policy,startedAt:null},182000).remainingMs,null);
assert.equal(executionPolicy({executionDeadlineMs:1200000},{TASK_TIMEOUT_MS:'180000'}).executionDeadlineMs,1200000);
assert.equal(executionPolicy({executionDeadlineMs:999999999},{}).executionDeadlineMs,86400000);
console.log('Independent execution deadline, progress silence and approval waiting passed');

assert.equal(executionPolicy({executionClass:'verified'},{}).executionDeadlineMs,1800000);
assert.equal(executionPolicy({executionClass:'verified'},{TASK_TIMEOUT_MS:'180000'}).executionDeadlineMs,1800000);
assert.equal(executionPolicy({executionClass:'verified'},{TASK_VERIFIED_EXECUTION_DEADLINE_MS:'2400000'}).executionDeadlineMs,2400000);
assert.equal(executionPolicy({executionClass:'verified',executionDeadlineMs:1000},{}).executionDeadlineMs,1000);
assert.equal(executionPolicy({executionClass:'verified'},{TASK_MAX_EXECUTION_MS:'120000'}).executionDeadlineMs,120000);
assert.equal(executionPolicy({executionClass:'invalid'},{}).executionClass,'query');

assert.equal(executionPolicy({},{}).allowClassPromotion,true);
assert.equal(executionPolicy({executionDeadlineMs:300},{}).allowClassPromotion,false);
assert.equal(executionPolicy({executionClass:'query'},{}).allowClassPromotion,false);
