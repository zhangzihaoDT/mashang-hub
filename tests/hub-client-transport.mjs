import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HubClient } from '../cli/hub-client.mjs';

let eventSocket, postSocket;
const server = createServer(async (req, res) => {
  assert.equal(req.headers.cookie, 'hub_session=synthetic-test');
  if (req.url === '/api/events') {
    eventSocket = req.socket;
    res.writeHead(200, { 'content-type':'text/event-stream' });
    res.write('event: mashang\r\ndata: {"type":"worker.status","status":"ONLINE"}\r\n\r\n');
    return;
  }
  postSocket = req.socket;
  let body = ''; for await (const chunk of req) body += chunk;
  res.writeHead(200, { 'content-type':'application/json' });
  res.end(JSON.stringify({ text:JSON.parse(body).text }));
});
const abort = new AbortController();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const watchdog = setTimeout(() => abort.abort(), 3000);
try {
  const client = new HubClient(`http://127.0.0.1:${server.address().port}`, { signal:abort.signal });
  client.profile.cookie = 'hub_session=synthetic-test';
  const events = [];
  const stream = await client.openEvents(event => events.push(event));
  const done = stream.done.catch(() => {});
  assert.deepEqual(await client.api('/probe', { text:'hello 的' }), { text:'hello 的' });
  assert.notEqual(postSocket, eventSocket, 'ordinary requests cannot be queued on the never-ending SSE connection');
  assert.ok(events.some(event => event.type === 'worker.status'));
  abort.abort(); await done;
  console.log('Hub transport: authenticated SSE on a dedicated socket, concurrent Unicode POST, CRLF events and abort cleanup passed');
} finally {
  clearTimeout(watchdog); abort.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
