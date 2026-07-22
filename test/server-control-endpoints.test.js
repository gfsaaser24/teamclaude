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
    // Mirrors index.js hooks.pinAccount: null token clears; an unknown token sets
    // no pin and signals {ok:false} so the endpoint returns 400 unknown_account.
    pinAccount: (token) => {
      if (token == null) {
        am.clearManualAccount();
      } else if (am.setManualAccount(token) == null) {
        return { ok: false, active: am.accounts[am.currentIndex]?.name ?? null };
      }
      am.selectActiveAccount();
      return { ok: true, active: am.accounts[am.currentIndex]?.name ?? null };
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

// Unknown id → 400 unknown_account, NOT 404. The desktop reads a 404 on this
// endpoint as "endpoint unsupported" and falls back to a legacy config write; a
// real "no such account" must surface as an error, so it is 400.
test('POST /teamclaude/account returns 400 unknown_account for an unknown id (never 404)', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id: 'ghost', disabled: true }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'unknown_account');
    // No account was touched.
    assert.equal(am.accounts.some(a => a.disabled), false);
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

// ── POST /teamclaude/account accepts a stable id ─────────────────────────────

test('POST /teamclaude/account resolves a stable id and applies live', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const id = accountStableId(am.accounts[0]); // 'u-alpha::o1'
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id, priority: 7 }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].priority, 7);
  });
});

// ── POST /teamclaude/pin ─────────────────────────────────────────────────────

test('POST /teamclaude/pin/<stable-id> pins by id and returns the active account', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const id = accountStableId(am.accounts[0]); // 'u-alpha::o1'
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/pin/${encodeURIComponent(id)}`, { method: 'POST', headers: KEY });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.active, 'alpha');
    assert.equal(am.manualIndex, 0);
  });
});

test('POST /teamclaude/pin/<name> pins by name too', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/pin/beta`, { method: 'POST', headers: KEY });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).active, 'beta');
    assert.equal(am.manualIndex, 1);
  });
});

test('POST /teamclaude/pin/<unknown> returns 400 unknown_account and sets no pin', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/pin/ghost`, { method: 'POST', headers: KEY });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'unknown_account');
    assert.equal(am.manualIndex, null); // no pin was set (no lie of success)
  });
});

test('POST /teamclaude/pin (no token) clears the pin with 200', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    am.setManualAccount('beta');
    assert.equal(am.manualIndex, 1);
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/pin`, { method: 'POST', headers: KEY });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(am.manualIndex, null);
  });
});

// ── body cap (413) ───────────────────────────────────────────────────────────

test('POST /teamclaude/account rejects a body over 1 MB with 413', async () => {
  await withServer(controlHooks, async ({ port, am }) => {
    // ~1.5 MB of JSON — over the 1 MB control-body cap.
    const big = JSON.stringify({ id: 'beta', pad: 'x'.repeat(1_500_000) });
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: big,
    });
    assert.equal(res.status, 413);
    assert.equal(am.accounts[1].priority ?? 0, 0); // nothing applied
  });
});

test('POST /teamclaude/routes rejects a body over 1 MB with 413', async () => {
  await withServer(controlHooks, async ({ port }) => {
    const big = JSON.stringify({ routes: [], pad: 'x'.repeat(1_500_000) });
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/routes`, {
      method: 'POST', headers: KEY, body: big,
    });
    assert.equal(res.status, 413);
  });
});

// ── disk-failure ordering (item 5c) ──────────────────────────────────────────

// Mirror index.js's setAccount write-order (persist to disk FIRST, then apply
// live) with a spy atomicConfigUpdate that throws — proving the endpoint returns
// 500 and the live AccountManager is left untouched (no live-but-not-persisted
// divergence). A passing variant proves live state IS applied after disk commits.
function orderingHooks(am, atomicConfigUpdate) {
  return {
    setAccount: async ({ id, disabled, priority }) => {
      const idx = am.accounts.findIndex(a => accountStableId(a) === id || a.name === id);
      if (idx < 0) return null;
      const mgr = am.accounts[idx];
      await atomicConfigUpdate(); // disk FIRST — throws here abort before live apply
      if (disabled != null) am.setDisabled(idx, disabled);
      if (priority != null) mgr.priority = priority;
      return { id: accountStableId(mgr), name: mgr.name, disabled: mgr.disabled || false, priority: mgr.priority || 0 };
    },
  };
}

test('POST /teamclaude/account returns 500 and leaves live state untouched when the disk write fails', async () => {
  let called = 0;
  const failingDisk = async () => { called++; throw new Error('disk full'); };
  await withServer((am) => orderingHooks(am, failingDisk), async ({ port, am }) => {
    const id = accountStableId(am.accounts[0]);
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id, disabled: true, priority: 5 }),
    });
    assert.equal(res.status, 500);
    assert.equal(called, 1);
    assert.equal(am.accounts[0].disabled ?? false, false); // live NOT mutated
    assert.equal(am.accounts[0].priority ?? 0, 0);
  });
});

test('POST /teamclaude/account applies live state only after the disk write commits', async () => {
  const order = [];
  const okDisk = async () => { order.push('disk'); };
  await withServer((am) => orderingHooks(am, okDisk), async ({ port, am }) => {
    const id = accountStableId(am.accounts[0]);
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/account`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ id, priority: 5 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(order, ['disk']); // disk ran (before the live apply below)
    assert.equal(am.accounts[0].priority, 5);
  });
});
