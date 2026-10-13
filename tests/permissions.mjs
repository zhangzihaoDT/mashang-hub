import assert from 'node:assert/strict';
import { Permissions } from '../worker/permissions.mjs';
const events = [], paused = [], resumed = [];
let fail = false, requests = [];
const permissions = new Permissions({ send: p => events.push(p), taskForSession: id => id === 'session' ? 'task' : null,
  directoryForSession: () => '/workspace', pause: id => paused.push(id), resume: id => resumed.push(id),
  request: async (path, options) => { if (fail) throw Error('offline'); if (path === '/permission') return requests; assert.equal(JSON.parse(options.body).response, 'once'); },
});
const ask = id => ({ type: 'permission.asked', properties: { id, sessionID: 'session', permission: 'external_directory', patterns: ['/profile/*'] } });
permissions.event(ask('first')); permissions.event(ask('second'));
assert.equal(events[0].taskId, 'task');
fail = true;
await permissions.reply({ requestId: 'first', replyId: 'reply1', response: 'once' });
assert.equal(events.at(-1).ok, false); assert.equal(permissions.pending.size, 2);
fail = false;
await permissions.reply({ requestId: 'first', replyId: 'reply2', response: 'once' });
assert.equal(events.at(-1).ok, true); assert.equal(resumed.length, 0);
permissions.event({ type: 'permission.replied', properties: { requestID: 'second', sessionID: 'session' } });
assert.equal(permissions.pending.size, 0); assert.deepEqual(resumed, ['task']);
assert.equal(events.at(-1).type, 'permission.resolved');
requests = [ask('missed').properties]; await permissions.sync();
assert.equal(permissions.pending.get('missed').taskId, 'task');
requests = []; await permissions.sync(); assert.equal(permissions.pending.size, 0);
permissions.event({ type: 'permission.asked', properties: { id: 'other', sessionID: 'other' } });
assert.equal(permissions.pending.size, 0);
console.log('Permission confirmation, retry, multiple requests and reconnect recovery passed');
