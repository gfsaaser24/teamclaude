import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { EventHub } from '../src/events.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeProxy(hooks) {
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  return createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' }, hooks);
}

test('GET /teamclaude/log returns recent events from the hook', async () => {
  const hub = new EventHub();
  hub.emit('request-end', { reqId: 1, status: 200 });
  const proxy = makeProxy({ getRecentEvents: () => hub.recent() });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/log`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].reqId, 1);
  } finally { proxy.close(); }
});

test('GET /teamclaude/log without hook returns empty list', async () => {
  const proxy = makeProxy({});
  const port = await listen(proxy);
  try {
    const data = await (await fetch(`http://127.0.0.1:${port}/teamclaude/log`)).json();
    assert.deepEqual(data.events, []);
  } finally { proxy.close(); }
});

test('GET /teamclaude/events streams hello frame then live events', { timeout: 20000 }, async () => {
  const hub = new EventHub();
  hub.emit('request-end', { reqId: 41, status: 200 });
  const proxy = makeProxy({ handleEvents: (req, res) => hub.handleSSE(req, res) });
  const port = await listen(proxy);
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Read the hello frame.
    while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
    assert.match(buf, /^event: hello/);
    assert.ok(buf.includes('"reqId":41'));

    // A live emit shows up on the open stream.
    hub.emit('request-start', { reqId: 42 });
    while (!buf.includes('"reqId":42')) buf += decoder.decode((await reader.read()).value);
    controller.abort();
  } finally { proxy.close(); }
});

test('GET /teamclaude/events without hook returns 501', async () => {
  const proxy = makeProxy({});
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/events`);
    assert.equal(res.status, 501);
  } finally { proxy.close(); }
});
