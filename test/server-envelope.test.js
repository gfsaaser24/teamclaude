import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { EventHub } from '../src/events.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function oauthAM() {
  return new AccountManager(
    [{
      name: 'a',
      accountUuid: 'uuid-a',
      orgUuid: 'org-a',
      type: 'oauth',
      accessToken: 't',
      refreshToken: 'r',
      expiresAt: Date.now() + 3600_000,
    }],
    0.98,
  );
}

// ── /teamclaude/log carries the bootId envelope (item 4) ─────────────────────

test('GET /teamclaude/log returns { bootId, events }', async () => {
  const bootId = randomUUID();
  const hub = new EventHub({ bootId });
  hub.emit('request-end', { reqId: 1, status: 200, durationMs: 12 });
  const proxy = createProxyServer(oauthAM(), { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' },
    { getRecentEvents: () => hub.recent(), getBootId: () => bootId });
  const port = await listen(proxy);
  try {
    const data = await (await fetch(`http://127.0.0.1:${port}/teamclaude/log`)).json();
    assert.equal(data.bootId, bootId);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].durationMs, 12);
  } finally { proxy.close(); }
});

test('GET /teamclaude/log bootId is null when no getBootId hook is wired', async () => {
  const proxy = createProxyServer(oauthAM(), { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' }, {});
  const port = await listen(proxy);
  try {
    const data = await (await fetch(`http://127.0.0.1:${port}/teamclaude/log`)).json();
    assert.equal(data.bootId, null);
    assert.deepEqual(data.events, []);
  } finally { proxy.close(); }
});

// ── SSE hello carries the bootId (item 4) ────────────────────────────────────

test('SSE hello frame includes the bootId', { timeout: 20000 }, async () => {
  const bootId = randomUUID();
  const hub = new EventHub({ bootId });
  const proxy = createProxyServer(oauthAM(), { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:1' },
    { handleEvents: (req, res) => hub.handleSSE(req, res) });
  const port = await listen(proxy);
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!buf.includes('\n\n')) buf += decoder.decode((await reader.read()).value);
    assert.match(buf, /^event: hello/);
    assert.ok(buf.includes(`"bootId":"${bootId}"`));
    controller.abort();
  } finally { proxy.close(); }
});

// ── bootId dedupe envelope across a simulated restart ────────────────────────

test('a restart changes bootId while event ids reset — key bootId:eventId disambiguates', () => {
  const boot1 = randomUUID();
  const hub1 = new EventHub({ bootId: boot1 });
  const e1 = hub1.emit('request-start', { reqId: 1 });
  assert.equal(e1.id, 1);

  // "Restart": a fresh process with a new bootId; numeric ids reset to 1.
  const boot2 = randomUUID();
  const hub2 = new EventHub({ bootId: boot2 });
  const e2 = hub2.emit('request-start', { reqId: 1 });
  assert.equal(e2.id, 1);            // same numeric id after restart...
  assert.notEqual(boot1, boot2);     // ...but a different bootId
  // A client keying by `${bootId}:${id}` never mis-associates the two.
  assert.notEqual(`${boot1}:${e1.id}`, `${boot2}:${e2.id}`);
});

// ── durationMs on request-end (item 5) ───────────────────────────────────────

test('request-end info carries a durationMs measured across the request', async () => {
  const upstream = http.createServer(async (_req, res) => {
    await new Promise(r => setTimeout(r, 25));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upPort = await listen(upstream);
  const am = oauthAM();
  let ended = null;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}` },
    { onRequestEnd: (_id, info) => { ended = info; } });
  const port = await listen(proxy);
  try {
    await (await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x' }),
    })).text();
    assert.ok(ended, 'onRequestEnd fired');
    assert.equal(typeof ended.durationMs, 'number');
    assert.ok(ended.durationMs >= 20, `durationMs (${ended.durationMs}) reflects the ~25ms upstream delay`);
    assert.equal(ended.accountId, 'uuid-a::org-a');
    assert.equal(ended.status, 200);
    assert.equal(ended.retryAfter, null);
    assert.equal(ended.limiterClass, 'none');
  } finally { proxy.close(); upstream.close(); }
});
