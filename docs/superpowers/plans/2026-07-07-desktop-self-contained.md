# TeamClaude Desktop — Self-Contained Proxy + Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the desktop app own its proxy end-to-end — its own config, an auto-chosen free port injected into the child, no environment-variable juggling and no accidental attach to an incompatible proxy — plus first-run account import, a Repair panel, and self-heal. This replaces the fragile shared-config/`TEAMCLAUDE_CONFIG` approach that left the app watching the wrong (old) proxy with an empty Activity feed.

**Architecture:** The app writes and reads its OWN proxy config at `<userData>/teamclaude-proxy.json` (never the user's shared `~/.config/teamclaude.json`). On launch it ensures that config exists and is valid, picks a free port, imports accounts from the user's existing shared config the first time (best-effort copy), and spawns the branch proxy with `TEAMCLAUDE_CONFIG=<that path>` set **in the child's env by the supervisor** (not by the user). The supervisor only attaches to a proxy that proves it has the new endpoints; otherwise it spawns its own. A Repair view exposes diagnostics + one-click fixes.

**Tech Stack:** Electron main (TS), electron-store, node:net, node:child_process. Renderer React + shadcn. vitest.

## Global Constraints

- Everything under `desktop/`. NEVER modify the proxy `src/` — the branch proxy already has the endpoints this needs.
- The app's proxy config is DEDICATED (`<userData>/teamclaude-proxy.json`), separate from the user's `~/.config/teamclaude.json`. The app may READ the shared config once to import accounts, but must never write to it.
- The supervisor injects `TEAMCLAUDE_CONFIG` into the spawned child's environment. No user-facing env var, ever.
- Never attach to a proxy that doesn't answer `GET /teamclaude/log` with 200 JSON (that's how we tell the new proxy from an old/foreign one on the same port).
- Credentials never reach the renderer (existing `redactConfig` boundary stays).
- TS strict; vitest colocated; `npm test`, `npm run typecheck`, `npm run build` all green per task. GUI-only behavior is user-verified.
- In dev the proxy command is `node <repoRoot>/src/index.js server --headless`; the repo root is resolved relative to the app, not hardcoded to one machine's path. (Packaging will bundle the proxy later — out of scope here.)
- Commit after each task (`feat(desktop): …`).

---

### Task 1: App-owned config provisioning + free-port picker

**Files:**
- Create: `desktop/src/main/app-proxy-config.ts`
- Test: `desktop/src/main/app-proxy-config.test.ts`

**Interfaces:**
- `findFreePort(preferred?: number): Promise<number>` — resolves a bindable loopback TCP port: tries `preferred` (default 51789) first, falls back to an OS-assigned ephemeral port. Uses `node:net`.
- `resolveRepoRoot(appPath: string): string` — given the Electron app dir, returns the teamclaude repo root whose `src/index.js` is the proxy (in dev this is the checkout containing `desktop/`). Implement by walking up from `appPath`/cwd to the first dir containing `src/index.js`; fall back to `process.cwd()`.
- `ensureAppProxyConfig(opts: { configPath: string; sharedConfigPath?: string }): Promise<{ path: string; port: number; apiKey: string; accountCount: number; imported: boolean }>` — if `configPath` exists AND parses AND has a `proxy.port`, return its port/apiKey. Otherwise provision: pick `findFreePort()`, generate `apiKey = 'tc-' + randomBytes(24).toString('base64url')`, and if `sharedConfigPath` exists and parses, copy its `accounts` (best-effort; import flag true), else `accounts: []`. Write atomically (tmp+rename, mode 0o600). A corrupt existing file is treated as missing (re-provisioned, old file backed up to `<path>.bak`).

- [ ] **Step 1: Failing test**
```ts
// desktop/src/main/app-proxy-config.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { findFreePort, ensureAppProxyConfig } from './app-proxy-config'

const dirs: string[] = []
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'tc-appcfg-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('findFreePort', () => {
  it('returns a bindable port', async () => {
    const p = await findFreePort()
    await new Promise<void>((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(p, '127.0.0.1', () => s.close(() => res())) })
    expect(p).toBeGreaterThan(1024)
  })
  it('falls back when preferred is taken', async () => {
    const busy = createServer(); const port = await new Promise<number>(r => busy.listen(0,'127.0.0.1',()=>r((busy.address() as {port:number}).port)))
    try { const p = await findFreePort(port); expect(p).not.toBe(port) } finally { busy.close() }
  })
})

describe('ensureAppProxyConfig', () => {
  it('provisions a new config with a free port and empty accounts', async () => {
    const dir = tmp(); const path = join(dir, 'teamclaude-proxy.json')
    const r = await ensureAppProxyConfig({ configPath: path })
    expect(r.port).toBeGreaterThan(1024)
    expect(r.apiKey).toMatch(/^tc-/)
    expect(r.accountCount).toBe(0)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    expect(onDisk.proxy.port).toBe(r.port)
  })
  it('imports accounts from a shared config on first provision', async () => {
    const dir = tmp(); const shared = join(dir, 'shared.json')
    writeFileSync(shared, JSON.stringify({ proxy: { port: 3456, apiKey: 'x' }, accounts: [{ name: 'a', type: 'oauth', accessToken: 't' }, { name: 'b', type: 'apikey', apiKey: 'k' }] }))
    const r = await ensureAppProxyConfig({ configPath: join(dir, 'app.json'), sharedConfigPath: shared })
    expect(r.accountCount).toBe(2)
    expect(r.imported).toBe(true)
  })
  it('reuses an existing valid config (stable port)', async () => {
    const dir = tmp(); const path = join(dir, 'app.json')
    const first = await ensureAppProxyConfig({ configPath: path })
    const second = await ensureAppProxyConfig({ configPath: path })
    expect(second.port).toBe(first.port)
    expect(second.apiKey).toBe(first.apiKey)
  })
  it('re-provisions a corrupt config and backs it up', async () => {
    const dir = tmp(); const path = join(dir, 'app.json')
    writeFileSync(path, '{ not json')
    const r = await ensureAppProxyConfig({ configPath: path })
    expect(r.port).toBeGreaterThan(1024)
    expect(existsSync(path + '.bak')).toBe(true)
  })
})
```
- [ ] **Step 2:** Run `npm test` → fails (module missing).
- [ ] **Step 3:** Implement `app-proxy-config.ts` per the Interfaces. `findFreePort`: bind a `net` server to `preferred` on 127.0.0.1; on success close and return it; on error bind to 0 and return the assigned port. `ensureAppProxyConfig`: read+parse guarded; on any failure (missing/corrupt) provision fresh (back up a corrupt file to `.bak` first). Atomic write via tmp+rename, mode 0o600.
- [ ] **Step 4:** `npm test` green; `npm run typecheck` clean.
- [ ] **Step 5:** Commit `feat(desktop): app-owned proxy config provisioning with free-port picker and account import`.

---

### Task 2: Supervisor — inject child env + compatibility-checked attach

**Files:**
- Modify: `desktop/src/main/supervisor.ts`
- Test: `desktop/src/main/supervisor.test.ts` (extend)

**Interfaces:**
- `SupervisorOptions` gains `env?: NodeJS.ProcessEnv` (merged over `process.env` for the spawned child) and `requireCompatible?: boolean` (default true).
- New private `isCompatible(): Promise<boolean>` — GET `/teamclaude/log` with the api key, 1.5s timeout; true only on a 2xx JSON response. `start()` attaches (state `attached`) only when `requireCompatible` is false OR `isCompatible()` is true; otherwise it does NOT attach to whatever is on the port — it spawns its own child (which will fail to bind if the port is truly occupied, surfacing as a crash the caller handles by re-provisioning a new port in Task 3).
- `spawnChild` passes `{ ...existing spawn opts, env: { ...process.env, ...(this.opts.env || {}) } }`.

- [ ] **Step 1: Failing tests** (extend the existing file; keep the fake-proxy harness)
```ts
// add to desktop/src/main/supervisor.test.ts
it('passes injected env to the spawned child', async () => {
  const port = await freePort()
  // fake proxy that only succeeds if TEAMCLAUDE_CONFIG is set: writes status only then
  const dir = mkdtempSync(join(tmpdir(), 'tcd-env-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'p.cjs')
  writeFileSync(script, `
    const http=require('http')
    if(!process.env.TEAMCLAUDE_CONFIG){process.exit(3)}
    http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end('{"events":[]}')}).listen(Number(process.argv[2]),'127.0.0.1')
  `)
  const sup = new Supervisor({ command: process.execPath, args: [script, String(port)], port, apiKey: 'k', env: { TEAMCLAUDE_CONFIG: 'x' } })
  cleanup.push(() => sup.stop())
  await sup.start(); await waitState(sup, 'running')
})

it('does NOT attach to an incompatible proxy (no /teamclaude/log)', async () => {
  // a server that answers /status but 404s /teamclaude/log
  const server = createServer((req,res)=>{ if(req.url==='/teamclaude/log'){res.writeHead(404);res.end()} else {res.writeHead(200);res.end('{}')} })
  const port = await listen(server); cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())))
  const sup = new Supervisor({ command: process.execPath, args: ['-e',''], port, apiKey: 'k' })
  await sup.start()
  expect(sup.state).not.toBe('attached')  // it must not claim the foreign proxy
})
```
(Import `mkdtempSync`, `rmSync`, `writeFileSync`, `tmpdir`, `join`, `createServer` as needed at the top of the test file.)
- [ ] **Step 2:** `npm test` → new tests fail.
- [ ] **Step 3:** Implement: add `env`/`requireCompatible` to options; add `isCompatible()`; gate the attach in `start()`; merge env in `spawnChild`. Keep the crash/backoff + taskkill logic intact.
- [ ] **Step 4:** `npm test` green (all supervisor tests, incl. the prior 3); `npm run typecheck` clean.
- [ ] **Step 5:** Commit `feat(desktop): supervisor injects child env and only attaches to a compatible proxy`.

---

### Task 3: Bootstrap on the app-owned proxy + expose proxy info + auto-reprovision port

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/main/ipc.ts` (add `tc:proxy:getInfo`)
- Modify: `desktop/src/preload/index.ts` (+ `index.d.ts`) — add `proxy.getInfo()`

**Interfaces:**
- Bootstrap: compute `appConfigPath = join(app.getPath('userData'), 'teamclaude-proxy.json')`; `sharedConfigPath = getTeamclaudeConfigPath()` (existing helper); `const prov = await ensureAppProxyConfig({ configPath: appConfigPath, sharedConfigPath })`. Build `ProxyClient({ port: prov.port, apiKey: prov.apiKey })` and `Supervisor({ command: 'node', args: [join(resolveRepoRoot(app.getAppPath()), 'src','index.js'), 'server', '--headless'], port: prov.port, apiKey: prov.apiKey, env: { TEAMCLAUDE_CONFIG: appConfigPath } })`. Remove the old `readTeamclaudeConfig()`-for-port path.
- If `supervisor.start()` results in `crashed` because the port was taken by something incompatible, re-provision a new free port (rewrite the app config's `proxy.port` via `ensureAppProxyConfig` after deleting the file, or a dedicated `reprovisionPort`) and restart once. Keep it simple: on first `crashed` within N seconds of start with the port occupied, pick a new free port, update the app config + client + supervisor port, and `start()` again (bounded to one retry).
- `window.tc.proxy.getInfo(): Promise<{ port: number; url: string; configPath: string }>` where `url = http://127.0.0.1:<port>`.

- [ ] **Step 1:** No unit test (Electron bootstrap). Implement the bootstrap change, the `tc:proxy:getInfo` handler (returns `{ port, url, configPath }` from the provisioned values held in main), and the preload method.
- [ ] **Step 2:** `npm run typecheck` clean; `npm run build` exit 0.
- [ ] **Step 3: Manual verification (director/user):** launch the app with NO env var; confirm it spawns a proxy on the provisioned port, `/teamclaude/log` responds, the Dashboard shows accounts, and the Activity tab receives events when traffic flows through that port.
- [ ] **Step 4:** Commit `feat(desktop): bootstrap the app-owned proxy on a provisioned port; expose proxy info`.

---

### Task 4: Repair panel + diagnostics IPC

**Files:**
- Create: `desktop/src/main/repair.ts` (diagnostics + actions, pure-ish, testable)
- Modify: `desktop/src/main/ipc.ts` (register `tc:repair:*`)
- Modify: `desktop/src/preload/index.ts` (+ d.ts) — add `repair` namespace
- Create: `desktop/src/renderer/src/views/Repair.tsx`
- Modify: `desktop/src/renderer/src/App.tsx` (add a Repair tab)
- Test: `desktop/src/main/repair.test.ts` (diagnostics logic)

**Interfaces:**
- `runDiagnostics(deps): Promise<Diag[]>` where `Diag = { id: string; label: string; ok: boolean; detail: string }` covering: config file valid JSON; proxy port listening; proxy compatible (`/teamclaude/log` 200); accounts configured (count > 0). `deps` are injected (config read fn, an `isUp`/`isCompatible` fn, port) so it's unit-testable without Electron.
- IPC + `window.tc.repair`: `diagnostics()`, `restart()` (→ supervisor.restart), `resetConfig()` (re-provision app config, keeping accounts if possible), `reimportAccounts()` (copy accounts from shared config into app config + reload), `newPort()` (pick a free port, rewrite app config, restart), `openConfigFolder()` / `openLogs()` (shell.openPath), `factoryReset()` (clear electron-store settings+projects AND delete the app proxy config, then restart).
- `Repair.tsx`: shows the proxy URL (with a copy button) from `proxy.getInfo()`, the diagnostics list with green/red, and buttons wired to the actions. After any action, re-run diagnostics.

- [ ] **Step 1: Failing test** for `runDiagnostics` (inject fakes: valid/invalid config, port up/down, compatible/not, accounts 0/2) asserting the four `Diag` entries flip `ok` correctly.
- [ ] **Step 2:** `npm test` → fails.
- [ ] **Step 3:** Implement `repair.ts` (`runDiagnostics` + the action helpers that main wires to supervisor/config), the IPC handlers, preload namespace, and `Repair.tsx` + the App tab.
- [ ] **Step 4:** `npm test` green; `npm run typecheck` clean; `npm run build` exit 0.
- [ ] **Step 5: Manual verification:** open Repair tab; diagnostics show all green against the running app proxy; "Restart" restarts; "Factory reset" clears settings and re-provisions cleanly.
- [ ] **Step 6:** Commit `feat(desktop): repair panel with diagnostics and one-click fixes`.

---

### Task 5: End-to-end verification + activity-render fix

**Files:**
- Verify across the app; fix any concrete gap found (most likely none once Tasks 1-3 point the client at the right proxy).

- [ ] **Step 1:** With the app running on its provisioned proxy, send traffic through that port (`TEAMCLAUDE_CONFIG=<appConfigPath> node <repo>/src/index.js run -- -p "hi"`, or via the app launcher). Confirm: Activity rows appear live, the request count on the Dashboard increments, and quota bars move as usage is observed.
- [ ] **Step 2:** If Activity does NOT populate while `/teamclaude/log` and `/events` show data, trace the SSE path (main `client.connectEvents` → `broadcast('tc:event')` → store `pushEvent` → `foldRequests` → Activity) and fix the break. Add a focused test if the bug is in `foldRequests`/`pushEvent`.
- [ ] **Step 3:** Commit any fix `fix(desktop): <specific activity-render fix>` (or record "verified, no fix needed" in the report).
