import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, injectEffort, isMutationRequest } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' };
const KEY = { 'x-api-key': 'k', 'content-type': 'application/json' };

// Wire the same disk-less getEffort/setEffort behavior index.js wires (minus
// atomicConfigUpdate — these tests exercise the endpoints + the live read the
// request path performs). `store` stands in for the in-memory config copy.
function effortHooks(store = {}) {
  return {
    getEffort: () => store.effort ?? null,
    setEffort: async (level) => {
      const effort = level ? { level } : null;
      if (effort) store.effort = effort; else delete store.effort;
      return effort;
    },
  };
}

function makeAM(overrides = {}) {
  return new AccountManager([{ name: 'backend', type: 'apikey', apiKey: 'sk-b', ...overrides }], 0.98);
}

async function withServer(hooks, run, accountOverrides) {
  const am = makeAM(accountOverrides);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try { return await run({ port, am }); } finally { proxy.close(); }
}

// An upstream that records the exact bytes and headers it was handed, so the
// injection can be judged on the wire rather than through a mock.
async function withUpstream(run) {
  let seen = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen = { raw: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [] }));
  });
  const port = await listen(upstream);
  try { return await run({ upstreamPort: port, seen: () => seen }); } finally { upstream.close(); }
}

const body = obj => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = buf => JSON.parse(buf.toString('utf8'));

// ── injectEffort: rule 5 (inject the pair) ───────────────────────────────────

test('injectEffort injects output_config.effort AND an adaptive thinking block', () => {
  const out = injectEffort(body({ model: 'kimi-k3', messages: [] }), 'high', 'kimi-k3');
  assert.deepEqual(parse(out), {
    model: 'kimi-k3',
    messages: [],
    output_config: { effort: 'high' },
    thinking: { type: 'adaptive' },
  });
});

test('injectEffort preserves other output_config keys and an existing adaptive/auto thinking block', () => {
  for (const type of ['adaptive', 'auto']) {
    const out = injectEffort(
      body({ model: 'kimi-k3', thinking: { type }, output_config: { max_tokens: 42 } }),
      'max', 'kimi-k3',
    );
    assert.deepEqual(parse(out), {
      model: 'kimi-k3',
      thinking: { type },                       // not rewritten to adaptive
      output_config: { max_tokens: 42, effort: 'max' },
    });
  }
});

// ── injectEffort: rule 1 (client wins) ───────────────────────────────────────

test('injectEffort leaves a client-supplied output_config.effort untouched', () => {
  const original = body({ model: 'kimi-k3', output_config: { effort: 'low' } });
  const out = injectEffort(original, 'max', 'kimi-k3');
  assert.equal(out, original);                  // same buffer — nothing rewritten
  assert.equal(parse(out).output_config.effort, 'low');
  assert.equal(parse(out).thinking, undefined); // and no thinking block invented
});

// ── injectEffort: rule 2 (no override set) ───────────────────────────────────

test('injectEffort is a no-op when no override level is set', () => {
  const original = body({ model: 'kimi-k3' });
  for (const level of [null, undefined, '']) {
    assert.equal(injectEffort(original, level, 'kimi-k3'), original);
  }
});

// ── injectEffort: rule 3 (incompatible thinking block) ───────────────────────

test('injectEffort declines when thinking.type is anything but adaptive/auto', () => {
  // With type:"enabled" CLIProxyAPI takes depth from budget_tokens and never
  // reads output_config.effort — injecting would overwrite intent for nothing.
  for (const thinking of [{ type: 'enabled', budget_tokens: 8000 }, { type: 'disabled' }, {}]) {
    const original = body({ model: 'kimi-k3', thinking });
    const out = injectEffort(original, 'high', 'kimi-k3');
    assert.equal(out, original);
    assert.equal(parse(out).output_config, undefined);
  }
});

// ── injectEffort: rule 4 (Anthropic guard) ───────────────────────────────────

test('injectEffort leaves a claude-* request untouched for none/minimal', () => {
  for (const level of ['none', 'minimal']) {
    const original = body({ model: 'claude-sonnet-4-6', messages: [] });
    const out = injectEffort(original, level, 'claude-sonnet-4-6');
    assert.equal(out, original);
    assert.deepEqual(parse(out), { model: 'claude-sonnet-4-6', messages: [] });
  }
});

test('injectEffort still injects the Anthropic-legal levels on a claude-* request', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const out = injectEffort(body({ model: 'claude-opus-5' }), level, 'claude-opus-5');
    assert.equal(parse(out).output_config.effort, level);
    assert.deepEqual(parse(out).thinking, { type: 'adaptive' });
  }
});

test('injectEffort injects none on a backend model, where it is valid', () => {
  const out = injectEffort(body({ model: 'grok-4.5' }), 'none', 'grok-4.5');
  assert.equal(parse(out).output_config.effort, 'none');
});

// ── injectEffort: defensive body handling ────────────────────────────────────

test('injectEffort returns a non-JSON, empty, or non-object body unchanged', () => {
  for (const raw of ['', 'not json at all', '[1,2,3]', '"scalar"', '42']) {
    const original = Buffer.from(raw, 'utf8');
    assert.equal(injectEffort(original, 'high', 'kimi-k3'), original);
  }
});

// ── endpoint: GET /teamclaude/effort ─────────────────────────────────────────

test('GET /teamclaude/effort returns null with no override (no key needed from loopback)', async () => {
  await withServer(effortHooks(), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { effort: null });
  });
});

test('GET /teamclaude/effort returns the current override', async () => {
  await withServer(effortHooks({ effort: { level: 'xhigh' } }), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { effort: { level: 'xhigh' } });
  });
});

// ── endpoint: POST /teamclaude/effort ────────────────────────────────────────

test('POST /teamclaude/effort is a mutation and requires the proxy key even from loopback', async () => {
  assert.equal(isMutationRequest('POST', '/teamclaude/effort'), true);
  assert.equal(isMutationRequest('GET', '/teamclaude/effort'), false);
  const store = {};
  await withServer(effortHooks(store), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'high' }),
    });
    assert.equal(res.status, 401);
    assert.equal(store.effort, undefined);      // nothing applied
  });
});

test('POST /teamclaude/effort sets every accepted level and reports it back', async () => {
  const store = {};
  await withServer(effortHooks(store), async ({ port }) => {
    for (const level of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ level }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, effort: { level } });
      assert.deepEqual(store.effort, { level });
    }
  });
});

test('POST /teamclaude/effort with null clears the override', async () => {
  const store = { effort: { level: 'max' } };
  await withServer(effortHooks(store), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ level: null }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, effort: null });
    assert.equal(store.effort, undefined);
    // And the GET agrees, so a client never sees a stale override.
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/teamclaude/effort`)).json(), { effort: null });
  });
});

test('POST /teamclaude/effort rejects an invalid level with 400 invalid_level and changes nothing', async () => {
  const store = { effort: { level: 'high' } };
  await withServer(effortHooks(store), async ({ port }) => {
    for (const level of ['minimal', 'HIGH', 'ultra', 5, true, {}]) {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
        method: 'POST', headers: KEY, body: JSON.stringify({ level }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_level');
    }
    assert.deepEqual(store.effort, { level: 'high' });
  });
});

test('POST /teamclaude/effort rejects a malformed JSON body with 400', async () => {
  await withServer(effortHooks(), async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
      method: 'POST', headers: KEY, body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

test('POST /teamclaude/effort returns 501 when no setEffort hook is wired', async () => {
  await withServer({}, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/effort`, {
      method: 'POST', headers: KEY, body: JSON.stringify({ level: 'high' }),
    });
    assert.equal(res.status, 501);
    // The GET degrades to "no override" rather than failing.
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/teamclaude/effort`)).json(), { effort: null });
  });
});

// ── end-to-end through the request path ──────────────────────────────────────

test('a set override reaches upstream on the forwarded body, ahead of the modelMap rewrite', async () => {
  await withUpstream(async ({ upstreamPort, seen }) => {
    await withServer(
      effortHooks({ effort: { level: 'max' } }),
      async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: KEY,
          body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
        });
        assert.equal(res.status, 200);
        const sent = seen();
        assert.deepEqual(JSON.parse(sent.raw), {
          model: 'orca-pro',                          // modelMap still applied, after
          messages: [],
          output_config: { effort: 'max' },
          thinking: { type: 'adaptive' },
        });
        // Content-Length must track the grown body or upstream truncates/stalls.
        assert.equal(sent.headers['content-length'], String(Buffer.byteLength(sent.raw)));
      },
      { upstream: `http://127.0.0.1:${upstreamPort}`, modelMap: { 'claude-sonnet-4-6': 'orca-pro' } },
    );
  });
});

// The guard is judged on the model the CLIENT asked for, which is why injection
// runs before rewriteModel: a claude-* id is still recognizable at that point.
test('a claude-* request with level none reaches upstream byte-for-byte untouched', async () => {
  await withUpstream(async ({ upstreamPort, seen }) => {
    await withServer(
      effortHooks({ effort: { level: 'none' } }),
      async ({ port }) => {
        const original = JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] });
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: KEY, body: original,
        });
        assert.equal(res.status, 200);
        assert.equal(seen().raw, original);
      },
      { upstream: `http://127.0.0.1:${upstreamPort}` },
    );
  });
});
