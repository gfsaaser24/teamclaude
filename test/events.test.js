// test/events.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EventHub } from '../src/events.js';

// Minimal req/res doubles: req is an EventEmitter (hub listens for 'close');
// res collects everything written.
function fakeClient() {
  const req = new EventEmitter();
  const res = {
    chunks: [],
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
  };
  return { req, res, text: () => res.chunks.join('') };
}

test('emit assigns increasing ids and returns the event', () => {
  const hub = new EventHub();
  const a = hub.emit('request-start', { reqId: 1, path: '/v1/messages' });
  const b = hub.emit('request-end', { reqId: 1, status: 200 });
  assert.equal(a.type, 'request-start');
  assert.equal(a.path, '/v1/messages');
  assert.ok(b.id > a.id);
  assert.ok(typeof a.ts === 'number');
});

test('ring buffer keeps only the last bufferSize events', () => {
  const hub = new EventHub({ bufferSize: 3 });
  for (let i = 0; i < 5; i++) hub.emit('e', { i });
  const recent = hub.recent();
  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map(e => e.i), [2, 3, 4]);
});

test('handleSSE sends headers, hello frame with recent events, then live frames', () => {
  const hub = new EventHub();
  hub.emit('request-end', { reqId: 7, status: 200 });
  const { req, res, text } = fakeClient();
  hub.handleSSE(req, res);

  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(text(), /^event: hello\ndata: /);
  const hello = JSON.parse(text().split('\n')[1].slice('data: '.length));
  assert.equal(hello.recent.length, 1);
  assert.equal(hello.recent[0].reqId, 7);

  const live = hub.emit('request-start', { reqId: 8 });
  assert.match(text(), new RegExp(`id: ${live.id}\\ndata: `));
  assert.ok(text().includes('"reqId":8'));
});

test('a closed client is removed and no longer written to', () => {
  const hub = new EventHub();
  const { req, res } = fakeClient();
  hub.handleSSE(req, res);
  assert.equal(hub.clientCount(), 1);
  req.emit('close');
  assert.equal(hub.clientCount(), 0);
  const before = res.chunks.length;
  hub.emit('e', {});
  assert.equal(res.chunks.length, before);
});
