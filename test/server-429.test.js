import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import * as serverModule from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('429 classification requires account-quota evidence', () => {
  assert.equal(typeof serverModule.classifyRateLimit429, 'function');
  const { classifyRateLimit429 } = serverModule;
  const genericBody = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Rate limited' },
  });
  assert.equal(classifyRateLimit429({}, genericBody), 'transient');
  assert.equal(classifyRateLimit429({
    'anthropic-ratelimit-unified-status': 'allowed_warning',
  }, genericBody), 'transient');
  assert.equal(classifyRateLimit429({
    'anthropic-ratelimit-unified-status': 'rejected',
  }, genericBody), 'account');
  assert.equal(classifyRateLimit429({}, JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'You have reached your weekly usage limit' },
  })), 'account');
});

// Drive one request through the proxy against an upstream that always 429s with
// the given Retry-After header, and report how the request terminated.
async function runAgainstThrottlingUpstream(retryAfterHeader) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': retryAfterHeader, 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    return { status: res.status, upstreamHits, accountStatus: am.accounts[0].status };
  } finally {
    proxy.close();
    upstream.close();
  }
}

// Regression: an opaque 429 must terminate after one attempt, not loop or
// reinterpret the shared limiter as account quota.
test('opaque upstream 429 terminates after one attempt without account throttle', async () => {
  const { status, upstreamHits, accountStatus } = await runAgainstThrottlingUpstream('1');
  assert.equal(status, 429);
  assert.equal(upstreamHits, 1);
  assert.equal(accountStatus, 'active');
});

// A negative (or otherwise out-of-range) Retry-After must not bypass the cap:
// it would make setTimeout return immediately and mark the account rate-limited
// in the past, reactivating it instantly.
test('negative Retry-After falls back to a bounded breaker without account throttle', async () => {
  const { status, upstreamHits, accountStatus } = await runAgainstThrottlingUpstream('-1');
  assert.equal(status, 429);
  assert.equal(upstreamHits, 1);
  assert.equal(accountStatus, 'active');
});

test('long upstream Retry-After is surfaced without sleeping in client request', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      assert.fail(`request should return 429 promptly, got ${err.name}`);
    }

    await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 1, 'long Retry-After should not be retried inline');
    assert.ok(Date.now() - started < 2000, 'request should not sleep for upstream retry window');
    assert.equal(res.headers.get('retry-after'), '15');
    assert.equal(am.accounts[0].status, 'active');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('generic 429 opens a shared egress breaker without rotating or throttling accounts', async () => {
  let now = 1_000_000;
  let upstreamHits = 0;
  let upstreamHealthy = false;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    if (upstreamHealthy) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', accountUuid: 'uuid-a', type: 'oauth', accessToken: 'ta' },
    { name: 'b', accountUuid: 'uuid-b', type: 'oauth', accessToken: 'tb' },
    { name: 'c', accountUuid: 'uuid-c', type: 'oauth', accessToken: 'tc' },
  ], 0.98, { now: () => now });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);
  const request = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
  });

  try {
    const first = await request();
    await first.text();
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('retry-after'), '15');
    assert.equal(upstreamHits, 1, 'the rejected request must not be sprayed across accounts');
    assert.deepEqual(am.accounts.map(a => a.status), ['active', 'active', 'active']);

    const blocked = await request();
    await blocked.text();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '15');
    assert.equal(upstreamHits, 1, 'an open breaker backpressures locally');

    now += 15_001;
    upstreamHealthy = true;
    const recovered = await request();
    await recovered.text();
    assert.equal(recovered.status, 200);
    assert.equal(upstreamHits, 2, 'traffic resumes after the breaker expires');
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('unified bucket quota 429 fails over with a model-scoped account hold', async () => {
  const tokens = [];
  const upstream = http.createServer((req, res) => {
    const token = req.headers.authorization;
    tokens.push(token);
    if (token === 'Bearer ta') {
      res.writeHead(429, {
        'retry-after': '3600',
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
        'anthropic-ratelimit-unified-7d_oi-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', accountUuid: 'uuid-a', type: 'oauth', accessToken: 'ta' },
    { name: 'b', accountUuid: 'uuid-b', type: 'oauth', accessToken: 'tb' },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(tokens, ['Bearer ta', 'Bearer tb']);
    assert.equal(am.accounts[0].status, 'active', 'family rejection is not account-global');
    assert.ok(am.accounts[0].rateLimitedBuckets.unified7dFable, 'governing bucket gets the hold');
    assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), false);
    assert.equal(am._isAvailable(am.accounts[0], 'claude-opus-4-6'), true);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('scoped fleet holds report their honest retry window and leave other models routable', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'ta' },
    { name: 'b', type: 'oauth', accessToken: 'tb' },
  ], 0.98);
  am.markRateLimited(0, 300, 'unified7dFable');
  am.markRateLimited(1, 300, 'unified7dFable');
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const blocked = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', messages: [] }),
    });
    await blocked.text();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '300');
    assert.equal(upstreamHits, 0);

    const allowed = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    await allowed.text();
    assert.equal(allowed.status, 200);
    assert.equal(upstreamHits, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('temporarily exhausted fleet waits and retries instead of surfacing synthetic 429', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  am.markRateLimited(0, 1);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();

    assert.equal(res.status, 200, text);
    assert.equal(upstreamHits, 1, 'request should reach upstream after throttle expires');
    assert.ok(Date.now() - started >= 900, 'request should wait for retry window');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Regression for #46: a stale/poisoned cached quota (e.g. 0.98 from before a
// plan upgrade, with a reset still in the future) must NOT pin the proxy in a
// permanent synthetic 429. The next request should probe upstream, succeed, and
// refresh the cached quota — rather than refusing locally without any call.
test('stale over-threshold quota is re-probed, not refused forever', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, {
      'content-type': 'application/json',
      // Real headroom: the upgraded account is nowhere near its limit.
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
    });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  // Simulate restoring a poisoned snapshot from teamclaude.state.json.
  am.restoreQuotaState([
    { name: 'a', quota: { unified7d: 0.98, unified7dReset: Date.now() + 7 * 24 * 3600_000 } },
  ]);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'request should be proxied, not refused with a synthetic 429');
    assert.equal(upstreamHits, 1, 'a real upstream probe should have been made');
    assert.equal(am.accounts[0].quota.unified7d, 0.10, 'cached quota should be refreshed from the probe');
  } finally {
    proxy.close();
    upstream.close();
  }
});
