# TeamClaude Desktop API Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP surface the desktop app needs to teamclaude: a live SSE event stream, a recent-events log endpoint, and a non-interactive OAuth login endpoint.

**Architecture:** A small `EventHub` (ring buffer + SSE fan-out) is created in `serverCommand()` and wired into the existing request hooks alongside the TUI. Three new routes in `server.js` delegate to hub/hook functions passed via the existing `hooks` object, exactly like `hooks.reload` / `hooks.getStatusExtra` today. OAuth login reuses the existing `loginOAuth()` (it already runs its own callback server and opens the browser); the endpoint kicks it off in the background and reports progress over the SSE stream.

**Tech Stack:** Node >=18, ESM JavaScript (no TypeScript in this repo), `node:test` for tests, no new dependencies.

## Global Constraints

- ESM only (`"type": "module"`); Node built-ins only — this package has zero runtime dependencies. Do not add any.
- All new endpoints sit BELOW the existing auth gate in `server.js` (the gate at src/server.js:55-65 already runs before routing) — do not add separate auth.
- Tests use `node:test` + `assert/strict`, listen on port 0, and follow the style of `test/server-log.test.js` (a `listen()` helper, try/finally close).
- Run tests with `node --test test/<file>` (single file) or `npm test` (all).
- Existing behavior must not change: TUI hooks must still fire, `/teamclaude/status` and `/teamclaude/reload` untouched.
- Commit after each task with a `feat:`/`test:` conventional message.

---

### Task 1: EventHub (ring buffer + SSE fan-out)

**Files:**
- Create: `src/events.js`
- Test: `test/events.test.js`

**Interfaces:**
- Consumes: nothing (pure Node built-ins).
- Produces: `class EventHub { constructor({ bufferSize = 200 } = {}); emit(type, data = {}) -> event; recent() -> event[]; handleSSE(req, res) -> void; clientCount() -> number }`. An `event` is `{ id: number, type: string, ts: number, ...data }`. `handleSSE` writes a `hello` SSE frame containing `{ recent: event[] }` then live frames (`id: <n>\ndata: <json>\n\n`). Task 2 and Task 4 rely on these exact names.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — `Cannot find module '.../src/events.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/events.js
/**
 * EventHub — in-memory event ring buffer with SSE fan-out.
 *
 * The server command emits request-lifecycle and oauth-flow events here; the
 * desktop UI subscribes via GET /teamclaude/events and backfills from the
 * ring buffer (sent as the initial `hello` frame, also exposed as
 * GET /teamclaude/log).
 */
export class EventHub {
  constructor({ bufferSize = 200 } = {}) {
    this.bufferSize = bufferSize;
    this.recentEvents = [];
    this.clients = new Set();
    this.nextEventId = 1;
  }

  emit(type, data = {}) {
    const event = { id: this.nextEventId++, type, ts: Date.now(), ...data };
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.bufferSize) this.recentEvents.shift();
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
    return event;
  }

  recent() {
    return [...this.recentEvents];
  }

  clientCount() {
    return this.clients.size;
  }

  handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ recent: this.recent() })}\n\n`);
    this.clients.add(res);
    // Keep intermediaries from timing out an idle stream; unref so the timer
    // never holds the process open.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* removed on close */ }
    }, 30_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test` then `npm run lint`
Expected: all existing tests still pass; no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: EventHub ring buffer with SSE fan-out"
```

---

### Task 2: /teamclaude/events and /teamclaude/log routes

**Files:**
- Modify: `src/server.js` (insert routes after the status endpoint block, src/server.js:68-74)
- Test: `test/server-events.test.js`

**Interfaces:**
- Consumes: `hooks.handleEvents(req, res)` and `hooks.getRecentEvents() -> event[]` — optional hook functions (Task 4 wires them to an `EventHub`).
- Produces: `GET /teamclaude/events` → SSE stream (501 JSON `{ok:false,error:'events not supported'}` if hook absent); `GET /teamclaude/log` → `200 {"events": [...]}` (empty array if hook absent).

- [ ] **Step 1: Write the failing test**

```js
// test/server-events.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-events.test.js`
Expected: FAIL — `/teamclaude/log` and `/teamclaude/events` fall through to the proxy forwarder (connection error / non-200), not the new routes.

- [ ] **Step 3: Add the routes**

In `src/server.js`, directly after the status endpoint block (after the `return;` at src/server.js:73-74) and before the reload endpoint, insert:

```js
      // Live event stream (SSE) — request lifecycle + oauth flow events for the
      // desktop UI. 501 when running without an EventHub (e.g. some tests).
      if (req.method === 'GET' && req.url === '/teamclaude/events') {
        if (!hooks.handleEvents) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'events not supported' }));
          return;
        }
        hooks.handleEvents(req, res);
        return;
      }

      // Recent-events backfill (same ring buffer the SSE hello frame sends).
      if (req.method === 'GET' && req.url === '/teamclaude/log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events: hooks.getRecentEvents?.() || [] }));
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-events.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test` then `npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.js test/server-events.test.js
git commit -m "feat: /teamclaude/events SSE stream and /teamclaude/log backfill endpoints"
```

---

### Task 3: OAuth login endpoint

**Files:**
- Modify: `src/oauth.js:261` (`loginOAuth` gains an options param)
- Modify: `src/server.js` (route after the /teamclaude/log block from Task 2)
- Test: `test/server-oauth-endpoint.test.js`

**Interfaces:**
- Consumes: `hooks.oauthLogin() -> Promise<{ started: true }>` (throws when a login is already in flight — Task 4 implements it).
- Produces: `POST /teamclaude/oauth/login` → `202 {ok:true, started:true}`, `409 {ok:false, error}` when already in flight, `501` when hook absent. `loginOAuth(opts)` now accepts `{ onAuthUrl?: (url: string) => void }` and is otherwise unchanged.

- [ ] **Step 1: Write the failing test**

```js
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
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST' });
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
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST' });
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
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/oauth/login`, { method: 'POST' });
    assert.equal(res.status, 501);
  } finally { proxy.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server-oauth-endpoint.test.js`
Expected: FAIL — route missing, request falls through to the forwarder.

- [ ] **Step 3: Add the route and the loginOAuth option**

In `src/server.js`, directly after the `/teamclaude/log` block from Task 2, insert:

```js
      // Kick off a browser OAuth login on this machine. Progress is reported on
      // the event stream (oauth-url / oauth-complete / oauth-error events).
      if (req.method === 'POST' && req.url === '/teamclaude/oauth/login') {
        if (!hooks.oauthLogin) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'oauth login not supported' }));
          return;
        }
        try {
          const result = await hooks.oauthLogin();
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }
```

In `src/oauth.js`, change the `loginOAuth` signature (src/oauth.js:261) from:

```js
export async function loginOAuth() {
```

to:

```js
export async function loginOAuth({ onAuthUrl } = {}) {
```

and directly after the `authUrl.searchParams.set('state', state);` line (src/oauth.js:280), add:

```js
  onAuthUrl?.(authUrl.toString());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server-oauth-endpoint.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full suite and lint**

Run: `npm test` then `npm run lint`
Expected: all pass (existing `loginOAuth()` callers pass no args — the default `{}` keeps them working).

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/oauth.js test/server-oauth-endpoint.test.js
git commit -m "feat: POST /teamclaude/oauth/login endpoint; loginOAuth onAuthUrl option"
```

---

### Task 4: Wire the hub and hooks in serverCommand

**Files:**
- Modify: `src/index.js` (`serverCommand()`, around src/index.js:250-332)

**Interfaces:**
- Consumes: `EventHub` from Task 1; route hooks from Tasks 2-3; existing `reloadAccounts`, `atomicConfigUpdate`, `sameIdentity`, `loginOAuth`, `fetchProfile`.
- Produces: a running server whose hooks emit `request-start`, `request-model`, `request-routed`, `request-end`, `oauth-start`, `oauth-url`, `oauth-complete`, `oauth-error` events. The desktop app (separate plan) consumes these event type names verbatim.

- [ ] **Step 1: Add the import**

In `src/index.js`, after the `renderStatus` import (src/index.js:18), add:

```js
import { EventHub } from './events.js';
```

- [ ] **Step 2: Create the hub and compose request hooks**

In `serverCommand()`, replace the current TUI hook block (src/index.js:250-295) — keep the `TUI` construction exactly as-is, but replace how `hooks` is built. Currently:

```js
  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({ ... });          // ← keep this constructor call unchanged
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestModel: (id, info) => tui.onRequestModel(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }
```

becomes (TUI constructor call stays inside `if (useTUI) { tui = new TUI({ ... }); }` with no `hooks =` assignment there anymore):

```js
  const hub = new EventHub();
  let tui = null;

  if (useTUI) {
    tui = new TUI({ ... });          // unchanged constructor arguments
  }

  // Request lifecycle fans out to the TUI (when present) AND the event hub, so
  // the desktop UI sees the same stream the TUI renders.
  const hooks = {
    onRequestStart: (id, info) => { tui?.onRequestStart(id, info); hub.emit('request-start', { reqId: id, ...info }); },
    onRequestModel: (id, info) => { tui?.onRequestModel(id, info); hub.emit('request-model', { reqId: id, ...info }); },
    onRequestRouted: (id, info) => { tui?.onRequestRouted(id, info); hub.emit('request-routed', { reqId: id, ...info }); },
    onRequestEnd: (id, info) => { tui?.onRequestEnd(id, info); hub.emit('request-end', { reqId: id, ...info }); },
  };
```

Note: `hooks` changes from `let` to `const` — the later `hooks.reload = ...` property assignments (src/index.js:298) still work on a `const` object.

- [ ] **Step 3: Wire the new hook functions**

Directly after the existing `hooks.reload = reloadAccounts;` line, add:

```js
  hooks.handleEvents = (req, res) => hub.handleSSE(req, res);
  hooks.getRecentEvents = () => hub.recent();

  // Browser OAuth login driven from the desktop UI. Runs the same loginOAuth
  // flow the CLI uses (it opens the browser and hosts the callback itself);
  // progress is reported as oauth-* events so the caller can just watch SSE.
  let oauthInFlight = false;
  hooks.oauthLogin = async () => {
    if (oauthInFlight) throw new Error('An OAuth login is already in progress');
    oauthInFlight = true;
    hub.emit('oauth-start', {});
    (async () => {
      try {
        const creds = await loginOAuth({ onAuthUrl: url => hub.emit('oauth-url', { url }) });
        const profile = await fetchProfile(creds.accessToken);
        const profileOk = profile && !profile.error;
        const account = {
          name: (profileOk && profile.email) || null,
          type: 'oauth',
          source: 'desktop',
          accountUuid: profileOk ? profile.accountUuid || null : null,
          orgUuid: profileOk ? profile.orgUuid || null : null,
          orgName: profileOk ? profile.orgName || null : null,
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt,
        };
        let savedName = null;
        await atomicConfigUpdate(diskConfig => {
          if (!account.name) {
            const n = diskConfig.accounts.filter(a => a.name.startsWith('account-')).length + 1;
            account.name = `account-${n}`;
          }
          let idx = diskConfig.accounts.findIndex(a => sameIdentity(a, account));
          if (idx < 0) idx = diskConfig.accounts.findIndex(a => a.name === account.name);
          if (idx >= 0) {
            // Same account+org: refresh credentials, keep the existing name.
            const prev = diskConfig.accounts[idx];
            diskConfig.accounts[idx] = { ...prev, ...account, name: prev.name };
            savedName = prev.name;
          } else {
            diskConfig.accounts.push(account);
            savedName = account.name;
          }
        });
        const added = await reloadAccounts();
        hub.emit('oauth-complete', { account: savedName, added });
      } catch (err) {
        hub.emit('oauth-error', { error: err.message });
      } finally {
        oauthInFlight = false;
      }
    })();
    return { started: true };
  };
```

- [ ] **Step 4: Run the full suite and lint**

Run: `npm test` then `npm run lint`
Expected: all pass (serverCommand has no direct unit tests; the suite guards against import/syntax regressions).

- [ ] **Step 5: Manual end-to-end verification**

Run the server headless in one terminal:

```powershell
node src/index.js server --headless
```

In another terminal:

```powershell
# Backfill endpoint
curl.exe -s http://localhost:3456/teamclaude/log
# Expected: {"events":[]} (or recent events if traffic has flowed)

# SSE stream: leave this running, then make any proxied request from a third
# terminal (e.g. `teamclaude run -- -p "hi"`); request-start/request-end
# frames must appear live.
curl.exe -sN http://localhost:3456/teamclaude/events
# Expected first frame: event: hello  /  data: {"recent":[...]}
```

Expected: hello frame immediately; live `request-*` frames when traffic flows. Stop both with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/index.js
git commit -m "feat: wire EventHub + oauth login hook into serverCommand"
```
