// test/server-oauth-endpoint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

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

test('POST /teamclaude/oauth/login starts the flow and returns 202', async () => {
  let calls = 0;
  const proxy = makeProxy({ oauthLogin: async () => { calls++; return { started: true }; } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.started, true);
    assert.equal(calls, 1);
  } finally { proxy.close(); }
});

test('POST /teamclaude/oauth/login returns 409 when already in flight', async () => {
  const proxy = makeProxy({ oauthLogin: async () => { throw new Error('An OAuth login is already in progress'); } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.match(data.error, /already in progress/);
  } finally { proxy.close(); }
});

test('POST /teamclaude/oauth/login without hook returns 501', async () => {
  const proxy = makeProxy({});
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST', headers: { 'x-api-key': 'k' } });
    assert.equal(res.status, 501);
  } finally { proxy.close(); }
});
