import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('six overlapping requests lease evenly across three accounts', { timeout: 10000 }, async () => {
  const routedTokens = [];
  let releaseUpstream;
  const allArrived = new Promise(resolve => { releaseUpstream = resolve; });
  const upstream = http.createServer(async (req, res) => {
    routedTokens.push(req.headers.authorization);
    if (routedTokens.length === 6) releaseUpstream();
    await allArrived;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', accountUuid: 'uuid-a', type: 'oauth', accessToken: 'ta' },
    { name: 'b', accountUuid: 'uuid-b', type: 'oauth', accessToken: 'tb' },
    { name: 'c', accountUuid: 'uuid-c', type: 'oauth', accessToken: 'tc' },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(
      `http://127.0.0.1:${proxyPort}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
        signal: AbortSignal.timeout(5000),
      },
    )));
    await Promise.all(responses.map(res => res.text()));
    assert.deepEqual(responses.map(res => res.status), [200, 200, 200, 200, 200, 200]);
    const counts = Object.fromEntries(['Bearer ta', 'Bearer tb', 'Bearer tc'].map(token => [
      token,
      routedTokens.filter(value => value === token).length,
    ]));
    assert.deepEqual(counts, { 'Bearer ta': 2, 'Bearer tb': 2, 'Bearer tc': 2 });
  } finally {
    proxy.close();
    upstream.close();
  }
});
