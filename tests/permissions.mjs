import assert from 'node:assert/strict';
import { Permissions } from '../worker/permissions.mjs';
const events = [], paused = [], resumed = [];
let owner = { taskId: 'task', userMessageId: 'user-current', attemptId: 'attempt', dispatchId: 'dispatch', directory: '/workspace' };
let fail = false, removeOnReply = false, delayed;
const requests = new Map(), messages = new Map();
const permissions = new Permissions({ send: p => events.push(p), taskForSession: id => id === 'session' ? owner : null,
  activeTaskIds: () => owner ? [owner.taskId] : [], pause: id => paused.push(id), resume: id => resumed.push(id),
  request: async (path, options) => {
    if (fail) throw Error('offline');
    if (path === '/permission') return [...requests.values()];
    if (path.endsWith('/reply')) { if (delayed) await delayed; if (removeOnReply) requests.delete(decodeURIComponent(path.split('/')[2])); return true; }
    return messages.get(decodeURIComponent(path.split('/').at(-1)));
  },
});
function ask(id, parent = 'user-current', status = 'running') {
  const messageID = `message-${id}`, callID = `call-${id}`;
  const request = { id, sessionID: 'session', permission: 'external_directory', patterns: ['/profile/*'], tool: { messageID, callID } };
  requests.set(id, request);
  messages.set(messageID, { info: { id: messageID, sessionID: 'session', role: 'assistant', parentID: parent }, parts: [{ type: 'tool', callID, state: { status } }] });
  return { type: 'permission.asked', properties: request };
}
const reply = id => ({ requestId: id, replyId: `reply-${id}`, response: 'once', ...owner });
await permissions.event(ask('old1', 'user-old', 'error'));
await permissions.event(ask('old2', 'user-old2'));
await permissions.event(ask('current'));
assert.deepEqual([...permissions.pending.keys()], ['current']);
assert.equal(events[0].taskId, 'task');
await permissions.sync(); assert.equal(permissions.pending.size, 1, 'historical approvals must not enter current task');
await permissions.reply(reply('current'));
assert.equal(events.at(-1).ok, false, 'HTTP success with request still pending is not confirmation');
assert.equal(permissions.pending.size, 1);
fail = true; await permissions.reply(reply('current')); assert.equal(events.at(-1).ok, false); fail = false;
removeOnReply = true; await permissions.reply(reply('current'));
assert.equal(events.at(-1).ok, true); assert.equal(permissions.pending.size, 0); assert.ok(requests.has('old1'), 'do not approve or reject old requests');
await permissions.event({type:'permission.asked', properties: {id:'current',sessionID:'session',tool:{messageID:'message-current',callID:'call-current'}}});
assert.equal(permissions.pending.size, 0, 'late snapshots must not resurrect confirmed requests');
const missing = ask('missing'); delete missing.properties.tool; await permissions.event(missing); assert.equal(permissions.pending.size, 0);
const mismatch = ask('mismatch'); messages.get('message-mismatch').parts[0].callID = 'different'; await permissions.event(mismatch); assert.equal(permissions.pending.size, 0);
const completed = ask('completed', 'user-current', 'completed'); await permissions.event(completed); assert.equal(permissions.pending.size, 0);
await permissions.event(ask('next')); await permissions.event(ask('next'));
assert.equal(permissions.pending.size, 1, 'duplicate event is one request');
await permissions.event(ask('another'));
await permissions.reply(reply('next')); assert.equal(permissions.pending.size, 1);
requests.delete('another'); await permissions.event({ type: 'permission.replied', properties: { requestID: 'another', sessionID: 'session' } });
assert.equal(permissions.pending.size, 0);
await permissions.event(ask('stale')); const staleReply = reply('stale'); owner = { ...owner, taskId: 'new-task', userMessageId: 'new-user', attemptId: 'new-attempt', dispatchId: 'new-dispatch' };
await permissions.reply(staleReply); assert.equal(events.at(-1).ok, false); assert.ok(requests.has('stale'));
await permissions.sync(); assert.equal(permissions.pending.size, 0);
await permissions.event(ask('unknown', 'new-user')); owner = null; await permissions.sync(); assert.equal(permissions.pending.size, 0);
console.log('Task/message/tool ownership, stale request filtering, real confirmation, retries and deduplication passed');
