import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isMutationRequest } from '../src/server.js';
import { accountStableId } from '../src/identity.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAM() {
  return new AccountManager([
    { name: 'alpha', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'u-alpha', orgUuid: 'o1' },
    { name: 'beta', type: 'apikey', apiKey: 'k' },
  ], 0.98);
}

const CONFIG = { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' };

// Wire the same disk-less setRoutes/setAccount behavior index.js wires (minus
// atomicConfigUpdate — these tests exercise the endpoint + live apply).
function controlHooks(am) {
  return {
    setRoutes: async (routes) => { am.setRoutes(routes); },
    setAccount: async ({ id, disabled, priority }) => {
      const idx = am.accounts.findIndex(a => accountStableId(a) === id || a.name === id);
      if (idx < 0) return null;
      const mgr = am.accounts[idx];
      if (disabled != null) am.setDisabled(idx, disabled);
      if (priority != null) mgr.priority = priority;
      return { id: accountStableId(mgr), name: mgr.name, disabled: mgr.disabled || false, priority: mgr.priority || 0 };
    },
  };
}

async function withServer(hooks, run) {
  const am = makeAM();
  const proxy = createProxyServer(am, CONFIG, hooks(am));
  const port = await listen(proxy);
  try { return await run({ port, am }); } finally { proxy.close(); }
}

const KEY = { 'x-api-key': 'k', 'content-type': 'application/json' };

// ── isMutationRequest ────────────────────────────────────────────────────────

test('isMutationRequest flags the mutating control endpoints only', () => {
  assert.equal(isMutationRequest('POST', '/teamclaude/routes'), true);
  assert.equal(isMutationRequest('POST', '/teamclaude/account'), true);
  assert.equal(isMutationRequest('POST', '/teamclaude/certs/ensure'), true);
  assert.equal(isMutationRequest('POST', '/teamclaude/pin/alpha'), true);
  assert.equal(isMutationRequest('POST', '/teamclaude/reload'), true);
  assert.equal(isMutationRequest('GET', '/teamclaude/routes'), false);   // read
  assert.equal(isMutationRequest('GET', '/teamclaude/status'), false);
  assert.equal(isMutationRequest('POST', '/v1/messages'), false);        // proxied
});

// ── GET /teamclaude/routes ───────────────────────────────────────────────────

test('GET /teamclaude/routes returns the editable persisted routes (no key needed from loopback)', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    am.setRoutes([{ name: 'fable', match: ['*fable*'], accounts: ['alpha'] }]);
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.routes, [{ name: 'fable', match: ['*fable*'], accounts: ['alpha'] }]);
  });
});

// ── POST /teamclaude/routes ──────────────────────────────────────────────────

test('POST /teamclaude/routes validates, normalizes to stable ids, and applies live', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ routes: [{ name: 'fable', match: '*fable*', accounts: ['alpha'] }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // 'alpha' normalized to its stable id, and applied to the live rotation.
    assert.deepEqual(body.routes, [{ name: 'fable', match: ['*fable*'], accounts: ['u-alpha::o1'] }]);
    assert.deepEqual(am.routes[0].accounts, ['u-alpha::o1']);
    assert.equal(am._isAvailable(am.accounts[1], 'claude-fable-5'), false); // beta barred
  });
});

test('POST /teamclaude/routes rejects object account references with 400', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ routes: [{ match: '*x*', accounts: [{ name: 'alpha', eligible: true }] }] }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).ok, false);
  });
});

test('POST /teamclaude/routes rejects numeric index references with 400', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY,
      body: JSON.stringify({ routes: [{ match: '*x*', accounts: ['0'] }] }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /teamclaude/routes rejects a malformed JSON body with 400', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY, body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

test('POST /teamclaude/routes returns 501 when no setRoutes hook is wired', async () => {
  await withServer(() => ({}), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ routes: [] }),
    });
    assert.equal(res.status, 501);
  });
});

// ── POST /teamclaude/account ─────────────────────────────────────────────────

test('POST /teamclaude/account disables an account by stable id and applies live', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const id = accountStableId(am.accounts[0]);
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id, disabled: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.account.disabled, true);
    assert.equal(am.accounts[0].disabled, true);      // applied to the live manager
  });
});

test('POST /teamclaude/account accepts a plain name (deprecation window) and sets priority', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id: 'beta', priority: -3 }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.accounts[1].priority, -3);
  });
});

test('POST /teamclaude/account returns 404 for an unknown id', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id: 'ghost', disabled: true }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST /teamclaude/account returns 400 without an id, or with wrong-typed fields', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const r1 = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ disabled: true }),
    });
    assert.equal(r1.status, 400);
    const r2 = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id: 'beta', priority: 'high' }),
    });
    assert.equal(r2.status, 400);
  });
});

// ── mutation key enforcement (item 5c) ───────────────────────────────────────

test('mutations require the key even from loopback; reads keep the exemption', async () => {
  await withServer(controlHooks, async ({ port }) => {
    // No x-api-key header, from loopback → 401 on a mutation.
    const mut = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routes: [] }),
    });
    assert.equal(mut.status, 401);
    // Same client, a read → still allowed (loopback exemption preserved).
    const read = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`);
    assert.equal(read.status, 200);
  });
});

test('a wrong key on a mutation is rejected 401 even from loopback', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: { 'x-api-key': 'wrong', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'beta' }),
    });
    assert.equal(res.status, 401);
  });
});
