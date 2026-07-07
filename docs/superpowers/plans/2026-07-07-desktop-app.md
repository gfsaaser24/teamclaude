# TeamClaude Desktop (Electron Tray + Flyout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron tray app in `desktop/` that owns the teamclaude proxy process and expands into a right-edge flyout panel (React + shadcn) replacing the terminal TUI, plus a project launcher that opens folders in Trae.

**Architecture:** Electron main process supervises the proxy child, holds the proxy API key, and proxies ALL HTTP/SSE traffic to teamclaude (renderer never talks to the network — avoids CORS and keeps credentials out of the renderer). Renderer is React + Tailwind v4 + shadcn/ui fed by a zustand store that main pushes events into via IPC. Config mutations (accounts, routes) are file edits to teamclaude's config JSON followed by `POST /teamclaude/reload`; account removal restarts the child.

**Tech Stack:** electron, electron-vite, electron-builder, React 19, TypeScript, Tailwind v4, shadcn/ui (+ Shadcn Studio registries), zustand, lucide-react, electron-store, vitest.

**Prerequisite:** The companion plan `2026-07-07-desktop-api.md` must be implemented first — this app consumes `GET /teamclaude/events`, `GET /teamclaude/log`, and `POST /teamclaude/oauth/login`, and the event types `request-start`, `request-model`, `request-routed`, `request-end`, `oauth-start`, `oauth-url`, `oauth-complete`, `oauth-error`.

## Global Constraints

- Everything in this plan lives under `desktop/` — never modify `src/` (the proxy) in this plan.
- `desktop/` is TypeScript; the proxy repo stays JavaScript. Don't add TS tooling to the repo root.
- The renderer NEVER receives `accessToken`, `refreshToken`, `apiKey`, or `proxy.apiKey` values — main redacts config before sending over IPC.
- The renderer NEVER does network I/O — all proxy traffic goes through main via the preload bridge.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (preload needs require) on all windows.
- Windows-first: verify on Windows 11; no platform-conditional code needed for macOS/Linux yet.
- teamclaude config path (mirror src/config.js:6-10): `%TEAMCLAUDE_CONFIG%` if set, else `$XDG_CONFIG_HOME/teamclaude.json`, else `~/.config/teamclaude.json`.
- Default proxy port 3456; always read the real port/apiKey from the config file.
- Unit tests: vitest, colocated as `*.test.ts` next to sources, `npm test` inside `desktop/`.
- Commit after each task (`feat(desktop): ...`).
- `desktop/.env` (Shadcn Studio credentials) already exists and is gitignored — never commit it.

---

### Task 1: Scaffold desktop/ (electron-vite + React + Tailwind + shadcn)

**Files:**
- Create: `desktop/` via scaffolder, then `desktop/components.json` (registries), `desktop/src/renderer/src/assets/main.css` (Tailwind), baseline configs.

**Interfaces:**
- Produces: a running empty Electron window via `npm run dev`; `npx shadcn@latest add <component>` works, including `@ss-components/*` premium registry items. Path alias `@renderer/*` → `desktop/src/renderer/src/*`.

- [ ] **Step 1: Scaffold with electron-vite**

```powershell
cd C:\code\teamclaude
npm create @quick-start/electron@latest desktop -- --template react-ts --skip
cd desktop
npm install
```

Note: `desktop/.env` and `desktop/CLAUDE.md` already exist in the folder — if the scaffolder refuses a non-empty directory, scaffold into `desktop-tmp`, move its contents into `desktop/` (keeping `.env` and `CLAUDE.md`), and delete `desktop-tmp`.

- [ ] **Step 2: Install runtime deps + Tailwind v4 + vitest**

```powershell
npm install zustand lucide-react electron-store clsx tailwind-merge class-variance-authority
npm install -D tailwindcss @tailwindcss/vite vitest
```

- [ ] **Step 3: Wire Tailwind v4 into the renderer**

In `desktop/electron.vite.config.ts`, add the Tailwind plugin to the renderer config:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
```

Replace the scaffolded renderer CSS with `desktop/src/renderer/src/assets/main.css`:

```css
@import "tailwindcss";
```

and ensure it is imported in `desktop/src/renderer/src/main.tsx`.

- [ ] **Step 4: Initialize shadcn with Shadcn Studio registries**

```powershell
npx shadcn@latest init
```

Answer: base color `zinc`, CSS variables `yes`. Then edit the generated `desktop/components.json` so it contains (keep whatever `aliases`/`tailwind` values init generated, add the `registries` block verbatim):

```json
{
  "registries": {
    "@ss-components": {
      "url": "https://shadcnstudio.com/r/components/{style}/{name}.json",
      "params": { "email": "${EMAIL}", "license_key": "${LICENSE_KEY}" }
    },
    "@ss-themes": {
      "url": "https://shadcnstudio.com/r/themes/{name}.json",
      "params": { "email": "${EMAIL}", "license_key": "${LICENSE_KEY}" }
    },
    "@ss-blocks": {
      "url": "https://shadcnstudio.com/r/blocks/{style}/{name}.json",
      "params": { "email": "${EMAIL}", "license_key": "${LICENSE_KEY}" }
    }
  }
}
```

(`${EMAIL}` / `${LICENSE_KEY}` resolve from `desktop/.env`, which already exists.)

Install the base components this plan uses:

```powershell
npx shadcn@latest add button card badge tabs progress scroll-area switch input label separator tooltip dialog select sonner
```

- [ ] **Step 5: Add vitest script and dark mode**

In `desktop/package.json` scripts add: `"test": "vitest run"`.
In `desktop/src/renderer/index.html` set `<html lang="en" class="dark">` (dark-mode-first per spec).

- [ ] **Step 6: Verify dev run**

Run: `npm run dev`
Expected: an Electron window opens showing the scaffold page with Tailwind styles applied. Close it.

- [ ] **Step 7: Commit**

```bash
git add desktop
git commit -m "feat(desktop): scaffold electron-vite + React + Tailwind v4 + shadcn with Shadcn Studio registries"
```

---

### Task 2: teamclaude config access (main process)

**Files:**
- Create: `desktop/src/main/teamclaude-config.ts`
- Test: `desktop/src/main/teamclaude-config.test.ts`

**Interfaces:**
- Produces:
  - `getTeamclaudeConfigPath(env?: NodeJS.ProcessEnv): string`
  - `readTeamclaudeConfig(): Promise<TcConfig | null>` (null when missing)
  - `updateTeamclaudeConfig(mutator: (cfg: TcConfig) => void): Promise<void>` (read → mutate → atomic tmp+rename write)
  - `redactConfig(cfg: TcConfig): RedactedConfig` — strips `accessToken`/`refreshToken`/`apiKey` from accounts and `proxy.apiKey`, adds `hasCredential: boolean` per account.
  - Types: `TcAccount { name; type: 'oauth'|'apikey'; orgName?; priority?; disabled?; accessToken?; refreshToken?; expiresAt?; apiKey? }`, `TcRoute { name; match: string[]; accounts?: string[]; bucket?: string }`, `TcConfig { proxy: { port: number; apiKey: string; host?: string }; upstream?: string; switchThreshold?: number; quotaProbeSeconds?: number; warmupSeconds?: number; routes?: TcRoute[]; accounts: TcAccount[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// desktop/src/main/teamclaude-config.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTeamclaudeConfigPath, readTeamclaudeConfig, updateTeamclaudeConfig, redactConfig } from './teamclaude-config'

const dirs: string[] = []
function tmpConfig(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-cfg-'))
  dirs.push(dir)
  const p = join(dir, 'teamclaude.json')
  writeFileSync(p, JSON.stringify(content))
  process.env.TEAMCLAUDE_CONFIG = p
  return p
}
afterEach(() => {
  delete process.env.TEAMCLAUDE_CONFIG
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('getTeamclaudeConfigPath', () => {
  it('honors TEAMCLAUDE_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(getTeamclaudeConfigPath({ TEAMCLAUDE_CONFIG: 'C:\\x\\tc.json' })).toBe('C:\\x\\tc.json')
    expect(getTeamclaudeConfigPath({ XDG_CONFIG_HOME: 'C:\\xdg' })).toBe(join('C:\\xdg', 'teamclaude.json'))
    expect(getTeamclaudeConfigPath({})).toContain(join('.config', 'teamclaude.json'))
  })
})

describe('read/update/redact', () => {
  const base = {
    proxy: { port: 3456, apiKey: 'tc-secret' },
    accounts: [
      { name: 'a@x.com', type: 'oauth', accessToken: 'sk-ant-oat-AAA', refreshToken: 'r', expiresAt: 1 },
      { name: 'api-1', type: 'apikey', apiKey: 'sk-ant-api-BBB', priority: 5 },
    ],
    routes: [{ name: 'opus', match: ['claude-opus-*'], accounts: ['a@x.com'] }],
  }

  it('reads the config from TEAMCLAUDE_CONFIG', async () => {
    tmpConfig(base)
    const cfg = await readTeamclaudeConfig()
    expect(cfg?.proxy.port).toBe(3456)
    expect(cfg?.accounts).toHaveLength(2)
  })

  it('returns null when the file does not exist', async () => {
    process.env.TEAMCLAUDE_CONFIG = join(tmpdir(), 'nope', 'missing.json')
    expect(await readTeamclaudeConfig()).toBeNull()
  })

  it('updateTeamclaudeConfig persists mutations atomically', async () => {
    const p = tmpConfig(base)
    await updateTeamclaudeConfig(cfg => { cfg.accounts[1].disabled = true })
    const onDisk = JSON.parse(readFileSync(p, 'utf8'))
    expect(onDisk.accounts[1].disabled).toBe(true)
    expect(onDisk.proxy.apiKey).toBe('tc-secret') // rest preserved
  })

  it('redactConfig strips every credential and flags presence', () => {
    const red = redactConfig(base as never)
    const json = JSON.stringify(red)
    expect(json).not.toContain('sk-ant-oat-AAA')
    expect(json).not.toContain('sk-ant-api-BBB')
    expect(json).not.toContain('tc-secret')
    expect(red.accounts[0].hasCredential).toBe(true)
    expect(red.proxy.port).toBe(3456)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// desktop/src/main/teamclaude-config.ts
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface TcAccount {
  name: string
  type: 'oauth' | 'apikey'
  orgName?: string | null
  priority?: number
  disabled?: boolean
  source?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  apiKey?: string
  importFrom?: string
}
export interface TcRoute { name: string; match: string[]; accounts?: string[]; bucket?: string }
export interface TcConfig {
  proxy: { port: number; apiKey: string; host?: string }
  upstream?: string
  switchThreshold?: number
  quotaProbeSeconds?: number
  warmupSeconds?: number
  routes?: TcRoute[]
  accounts: TcAccount[]
}
export interface RedactedAccount extends Omit<TcAccount, 'accessToken' | 'refreshToken' | 'apiKey'> {
  hasCredential: boolean
}
export interface RedactedConfig extends Omit<TcConfig, 'proxy' | 'accounts'> {
  proxy: { port: number; host?: string }
  accounts: RedactedAccount[]
}

// Mirrors src/config.js getConfigPath() so both sides always agree.
export function getTeamclaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TEAMCLAUDE_CONFIG) return env.TEAMCLAUDE_CONFIG
  const configDir = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configDir, 'teamclaude.json')
}

export async function readTeamclaudeConfig(): Promise<TcConfig | null> {
  try {
    return JSON.parse(await readFile(getTeamclaudeConfigPath(), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function updateTeamclaudeConfig(mutator: (cfg: TcConfig) => void): Promise<void> {
  const path = getTeamclaudeConfigPath()
  const cfg = JSON.parse(await readFile(path, 'utf8')) as TcConfig
  mutator(cfg)
  const tmp = `${path}.tmp-desktop`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

export function redactConfig(cfg: TcConfig): RedactedConfig {
  return {
    ...cfg,
    proxy: { port: cfg.proxy.port, host: cfg.proxy.host },
    accounts: cfg.accounts.map(({ accessToken, refreshToken, apiKey, ...rest }) => ({
      ...rest,
      hasCredential: Boolean(accessToken || apiKey || rest.importFrom),
    })),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop; npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/teamclaude-config.ts desktop/src/main/teamclaude-config.test.ts
git commit -m "feat(desktop): teamclaude config reader/updater with credential redaction"
```

---

### Task 3: Proxy supervisor (spawn / attach / restart)

**Files:**
- Create: `desktop/src/main/supervisor.ts`
- Test: `desktop/src/main/supervisor.test.ts`

**Interfaces:**
- Consumes: `readTeamclaudeConfig` (Task 2).
- Produces: `class Supervisor extends EventEmitter` with:
  - `constructor(opts: { command: string; args: string[]; port: number; apiKey: string })`
  - `start(): Promise<void>` — if `isUp()` already true → state `attached`; else spawn child → `starting` → poll `isUp()` → `running`.
  - `stop(): Promise<void>`, `restart(): Promise<void>`
  - `isUp(): Promise<boolean>` — GET `http://127.0.0.1:{port}/teamclaude/status` with `x-api-key`, 1.5s timeout.
  - `state: 'stopped'|'starting'|'running'|'attached'|'crashed'`; emits `'state'` with the new state; auto-restarts a crashed child with exponential backoff (1s, 2s, 4s... cap 30s), never restarts after `stop()`.
  - Task 5 consumes `state` + `'state'` events for the tray icon; Task 4 exposes start/stop/restart over IPC.

- [ ] **Step 1: Write the failing test**

Testing strategy: drive the supervisor against a tiny throwaway Node script that acts as the "proxy" (listens on a port, answers `/teamclaude/status`), so no Electron and no real teamclaude needed.

```ts
// desktop/src/main/supervisor.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from './supervisor'

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })

function listen(server: Server): Promise<number> {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)))
}

// A stand-in "proxy" script the supervisor can spawn: serves /teamclaude/status
// on the port given as argv[2].
function fakeProxyScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-sup-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const p = join(dir, 'fake-proxy.cjs')
  writeFileSync(p, `
    const http = require('http')
    http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end('{"accounts":[]}')
    }).listen(Number(process.argv[2]), '127.0.0.1')
  `)
  return p
}

function freePort(): Promise<number> {
  const s = createServer()
  return listen(s).then(port => new Promise(res => s.close(() => res(port))))
}

function waitState(sup: Supervisor, want: string, ms = 10000): Promise<void> {
  return new Promise((res, rej) => {
    if (sup.state === want) return res()
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${want} (at ${sup.state})`)), ms)
    sup.on('state', s => { if (s === want) { clearTimeout(t); res() } })
  })
}

describe('Supervisor', () => {
  it('attaches when something already answers on the port', async () => {
    const server = createServer((_q, r) => { r.writeHead(200); r.end('{}') })
    const port = await listen(server)
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const sup = new Supervisor({ command: process.execPath, args: ['-e', ''], port, apiKey: 'k' })
    await sup.start()
    expect(sup.state).toBe('attached')
  })

  it('spawns the child and reaches running, then stops cleanly', async () => {
    const port = await freePort()
    const script = fakeProxyScript()
    const sup = new Supervisor({ command: process.execPath, args: [script, String(port)], port, apiKey: 'k' })
    cleanup.push(() => sup.stop())
    await sup.start()
    await waitState(sup, 'running')
    await sup.stop()
    expect(sup.state).toBe('stopped')
    expect(await sup.isUp()).toBe(false)
  })

  it('marks crashed and schedules a restart when the child dies', async () => {
    const port = await freePort()
    const script = fakeProxyScript()
    const sup = new Supervisor({ command: process.execPath, args: [script, String(port)], port, apiKey: 'k' })
    cleanup.push(() => sup.stop())
    await sup.start()
    await waitState(sup, 'running')
    sup.child!.kill()
    await waitState(sup, 'crashed')
    await waitState(sup, 'running')   // backoff restart brings it back
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// desktop/src/main/supervisor.ts
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'

export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'

export interface SupervisorOptions {
  command: string
  args: string[]
  port: number
  apiKey: string
}

/**
 * Owns the teamclaude child process. If a proxy already answers on the port we
 * attach instead of spawning (dev convenience + single-proxy invariant). A
 * crashed child restarts with exponential backoff; stop() disarms everything.
 */
export class Supervisor extends EventEmitter {
  state: SupervisorState = 'stopped'
  child: ChildProcess | null = null
  lastLogLines: string[] = []
  private opts: SupervisorOptions
  private stopping = false
  private backoffMs = 1000
  private restartTimer: NodeJS.Timeout | null = null

  constructor(opts: SupervisorOptions) {
    super()
    this.opts = opts
  }

  private setState(s: SupervisorState): void {
    this.state = s
    this.emit('state', s)
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/teamclaude/status`, {
        headers: { 'x-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(1500),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    this.stopping = false
    if (await this.isUp()) {
      this.setState('attached')
      return
    }
    this.spawnChild()
  }

  private spawnChild(): void {
    this.setState('starting')
    const child = spawn(this.opts.command, this.opts.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',   // resolve teamclaude.cmd shims
      windowsHide: true,
    })
    this.child = child
    const capture = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue
        this.lastLogLines.push(line)
        if (this.lastLogLines.length > 100) this.lastLogLines.shift()
        this.emit('log', line)
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('exit', () => {
      this.child = null
      if (this.stopping) { this.setState('stopped'); return }
      this.setState('crashed')
      this.restartTimer = setTimeout(() => this.spawnChild(), this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000)
    })
    // Poll until the status endpoint answers, then we're running.
    const poll = setInterval(async () => {
      if (this.child !== child) { clearInterval(poll); return }
      if (await this.isUp()) {
        clearInterval(poll)
        this.backoffMs = 1000
        this.setState('running')
      }
    }, 500)
    poll.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    const child = this.child
    if (!child) { this.setState('stopped'); return }
    await new Promise<void>(resolve => {
      const done = (): void => resolve()
      child.once('exit', done)
      child.kill()                                     // SIGTERM → teamclaude's graceful shutdown
      setTimeout(() => { child.kill('SIGKILL'); }, 5000).unref?.()
    })
    this.child = null
    this.setState('stopped')
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop; npm test`
Expected: PASS (3 supervisor tests; the crash test takes ~2s for the backoff).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/supervisor.ts desktop/src/main/supervisor.test.ts
git commit -m "feat(desktop): proxy supervisor with attach, crash backoff restart"
```

---

### Task 4: Proxy client, SSE forwarder, IPC surface, preload bridge

**Files:**
- Create: `desktop/src/main/proxy-client.ts`
- Create: `desktop/src/main/ipc.ts`
- Replace: `desktop/src/preload/index.ts` (and `index.d.ts`)
- Test: `desktop/src/main/proxy-client.test.ts`

**Interfaces:**
- Consumes: Task 2 config module, Task 3 `Supervisor`.
- Produces (this is the contract every renderer task consumes — exact names):

```ts
// window.tc — exposed by preload
interface TcBridge {
  proxy: {
    getState(): Promise<{ state: SupervisorState; port: number; recentLog: string[] }>
    start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>
    onState(cb: (state: SupervisorState) => void): () => void
  }
  api: {
    status(): Promise<TcStatus>            // GET /teamclaude/status (verbatim JSON)
    recentEvents(): Promise<TcEvent[]>     // GET /teamclaude/log → .events
    reload(): Promise<{ ok: boolean; added?: number }>
    oauthLogin(): Promise<{ ok: boolean; error?: string }>
    onEvent(cb: (evt: TcEvent) => void): () => void   // live SSE events
  }
  config: {
    get(): Promise<RedactedConfig | null>
    setAccountDisabled(name: string, disabled: boolean): Promise<void>  // edit config + reload
    setAccountPriority(name: string, priority: number): Promise<void>  // edit config + reload
    removeAccount(name: string): Promise<void>                          // edit config + RESTART child
    setRoutes(routes: TcRoute[]): Promise<void>                         // edit config + reload
  }
  launcher: {
    list(): Promise<Project[]>             // Project = { path: string; name: string; autorun: string | null }
    add(p: Project): Promise<void>; remove(path: string): Promise<void>
    open(path: string): Promise<{ ok: boolean; error?: string }>
    pickFolder(): Promise<string | null>   // native directory dialog
  }
  settings: {
    get(): Promise<AppSettings>            // { editorCommand: string; hotkey: string; launchAtLogin: boolean; teamclaudeCommand: string; teamclaudeArgs: string[] }
    set(partial: Partial<AppSettings>): Promise<AppSettings>
  }
  window: { setPinned(pinned: boolean): Promise<void>; hide(): Promise<void> }
}
```

  - `TcEvent = { id: number; type: string; ts: number; [k: string]: unknown }`; `TcStatus` is the `/teamclaude/status` JSON: `{ currentAccount, switchThreshold, routes, accounts: [{ name, type, orgName, priority, disabled, status, quota, usage, rateLimitedUntil }], server: { startedAt, uptimeSeconds, port, upstream }, probe, warm }`.
  - `ProxyClient` (main): `constructor({ port, apiKey })`, `status()`, `recentEvents()`, `reload()`, `oauthLogin()`, `connectEvents(onEvent): () => void` (SSE over `http.get`, auto-reconnect 2s backoff, returns disconnect fn).

- [ ] **Step 1: Write the failing test for ProxyClient SSE parsing + reconnect**

```ts
// desktop/src/main/proxy-client.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { ProxyClient } from './proxy-client'

let servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise(res => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)))
}

describe('ProxyClient', () => {
  it('status() sends the api key and parses JSON', async () => {
    let gotKey = ''
    const server = createServer((req, res) => {
      gotKey = String(req.headers['x-api-key'])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ currentAccount: 'a', accounts: [] }))
    })
    const port = await listen(server)
    const client = new ProxyClient({ port, apiKey: 'sekrit' })
    const status = await client.status()
    expect(status.currentAccount).toBe('a')
    expect(gotKey).toBe('sekrit')
  })

  it('connectEvents parses SSE frames (hello recent + live) and reconnects', async () => {
    let conns = 0
    let live: ServerResponse | null = null
    const server = createServer((_req, res) => {
      conns++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: hello\ndata: ${JSON.stringify({ recent: [{ id: 1, type: 'request-end', ts: 1 }] })}\n\n`)
      live = res
    })
    const port = await listen(server)
    const client = new ProxyClient({ port, apiKey: 'k', reconnectMs: 100 })
    const events: unknown[] = []
    const disconnect = client.connectEvents(e => events.push(e))
    try {
      await new Promise(r => setTimeout(r, 300))
      expect(events).toHaveLength(1)                        // hello backfill delivered
      live!.write(`id: 2\ndata: ${JSON.stringify({ id: 2, type: 'request-start', ts: 2 })}\n\n`)
      await new Promise(r => setTimeout(r, 200))
      expect(events).toHaveLength(2)
      live!.end()                                           // server drops the stream
      await new Promise(r => setTimeout(r, 500))
      expect(conns).toBeGreaterThanOrEqual(2)               // it reconnected
    } finally { disconnect() }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProxyClient**

```ts
// desktop/src/main/proxy-client.ts
import http from 'node:http'

export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }

export class ProxyClient {
  private port: number
  private apiKey: string
  private reconnectMs: number

  constructor({ port, apiKey, reconnectMs = 2000 }: { port: number; apiKey: string; reconnectMs?: number }) {
    this.port = port
    this.apiKey = apiKey
    this.reconnectMs = reconnectMs
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-api-key': this.apiKey, ...(init.headers || {}) },
      signal: AbortSignal.timeout(10_000),
    })
    return (await res.json()) as T
  }

  status(): Promise<Record<string, unknown>> { return this.json('/teamclaude/status') }
  recentEvents(): Promise<TcEvent[]> {
    return this.json<{ events: TcEvent[] }>('/teamclaude/log').then(d => d.events)
  }
  reload(): Promise<{ ok: boolean; added?: number }> { return this.json('/teamclaude/reload', { method: 'POST' }) }
  oauthLogin(): Promise<{ ok: boolean; error?: string }> { return this.json('/teamclaude/oauth/login', { method: 'POST' }) }

  /**
   * Subscribe to /teamclaude/events. The hello frame's `recent` array is
   * replayed through onEvent one by one, then live events stream in.
   * Reconnects forever until the returned disconnect fn is called.
   */
  connectEvents(onEvent: (evt: TcEvent) => void): () => void {
    let stopped = false
    let req: http.ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null

    const connect = (): void => {
      if (stopped) return
      req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/teamclaude/events', headers: { 'x-api-key': this.apiKey } },
        res => {
          let buf = ''
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString()
            let sep: number
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep)
              buf = buf.slice(sep + 2)
              const isHello = /^event: hello$/m.test(frame)
              const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
              if (!dataLine) continue
              try {
                const data = JSON.parse(dataLine.slice('data: '.length))
                if (isHello) for (const e of data.recent as TcEvent[]) onEvent(e)
                else onEvent(data as TcEvent)
              } catch { /* skip malformed frame */ }
            }
          })
          res.on('end', schedule)
          res.on('error', schedule)
        },
      )
      req.on('error', schedule)
    }
    const schedule = (): void => {
      if (stopped || timer) return
      timer = setTimeout(() => { timer = null; connect() }, this.reconnectMs)
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      req?.destroy()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop; npm test`
Expected: PASS.

Note: the reconnect delivers the hello backfill again — dedupe by event `id` belongs in the renderer store (Task 6), not here.

- [ ] **Step 5: Implement the IPC layer**

```ts
// desktop/src/main/ipc.ts
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Store from 'electron-store'
import type { Supervisor } from './supervisor'
import { ProxyClient, type TcEvent } from './proxy-client'
import { readTeamclaudeConfig, updateTeamclaudeConfig, redactConfig, type TcRoute } from './teamclaude-config'

export interface Project { path: string; name: string; autorun: string | null }
export interface AppSettings {
  editorCommand: string
  hotkey: string
  launchAtLogin: boolean
  teamclaudeCommand: string
  teamclaudeArgs: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  editorCommand: 'trae',
  hotkey: 'Control+Shift+Space',
  launchAtLogin: false,
  teamclaudeCommand: 'teamclaude',
  teamclaudeArgs: ['server', '--headless'],
}

export interface IpcDeps {
  supervisor: Supervisor
  client: ProxyClient
  store: Store<{ settings: AppSettings; projects: Project[] }>
  getFlyout: () => BrowserWindow | null
  setPinned: (pinned: boolean) => void
  applySettings: (s: AppSettings) => void   // re-register hotkey, login item (Task 5)
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

export function registerIpc(deps: IpcDeps): () => void {
  const { supervisor, client, store } = deps

  supervisor.on('state', s => broadcast('tc:proxy-state', s))
  const disconnectEvents = client.connectEvents((evt: TcEvent) => broadcast('tc:event', evt))

  ipcMain.handle('tc:proxy:getState', async () => {
    const cfg = await readTeamclaudeConfig()
    return { state: supervisor.state, port: cfg?.proxy.port ?? 3456, recentLog: supervisor.lastLogLines }
  })
  ipcMain.handle('tc:proxy:start', () => supervisor.start())
  ipcMain.handle('tc:proxy:stop', () => supervisor.stop())
  ipcMain.handle('tc:proxy:restart', () => supervisor.restart())

  ipcMain.handle('tc:api:status', () => client.status())
  ipcMain.handle('tc:api:recentEvents', () => client.recentEvents())
  ipcMain.handle('tc:api:reload', () => client.reload())
  ipcMain.handle('tc:api:oauthLogin', () => client.oauthLogin())

  ipcMain.handle('tc:config:get', async () => {
    const cfg = await readTeamclaudeConfig()
    return cfg ? redactConfig(cfg) : null
  })
  ipcMain.handle('tc:config:setAccountDisabled', async (_e, name: string, disabled: boolean) => {
    await updateTeamclaudeConfig(cfg => {
      const a = cfg.accounts.find(x => x.name === name)
      if (!a) throw new Error(`No account named "${name}"`)
      if (disabled) a.disabled = true; else delete a.disabled
    })
    await client.reload()
  })
  ipcMain.handle('tc:config:setAccountPriority', async (_e, name: string, priority: number) => {
    await updateTeamclaudeConfig(cfg => {
      const a = cfg.accounts.find(x => x.name === name)
      if (!a) throw new Error(`No account named "${name}"`)
      a.priority = priority
    })
    await client.reload()
  })
  ipcMain.handle('tc:config:removeAccount', async (_e, name: string) => {
    await updateTeamclaudeConfig(cfg => {
      cfg.accounts = cfg.accounts.filter(x => x.name !== name)
    })
    await supervisor.restart()   // removals don't apply via reload (see src/index.js notifyRunningServer docs)
  })
  ipcMain.handle('tc:config:setRoutes', async (_e, routes: TcRoute[]) => {
    await updateTeamclaudeConfig(cfg => { cfg.routes = routes })
    await client.reload()
  })

  ipcMain.handle('tc:launcher:list', () => store.get('projects', []))
  ipcMain.handle('tc:launcher:add', (_e, p: Project) => {
    const projects = store.get('projects', []).filter(x => x.path !== p.path)
    store.set('projects', [...projects, p])
  })
  ipcMain.handle('tc:launcher:remove', (_e, path: string) => {
    store.set('projects', store.get('projects', []).filter(x => x.path !== path))
  })
  ipcMain.handle('tc:launcher:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('tc:launcher:open', async (_e, path: string) => {
    const settings = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }
    const project = store.get('projects', []).find(p => p.path === path)
    try {
      // Best-effort auto-terminal: a folderOpen task that runs the project's
      // autorun command in the editor's integrated terminal. Written only when
      // the project opted in (autorun set) and no tasks.json exists yet.
      if (project?.autorun) {
        const vscodeDir = join(path, '.vscode')
        await mkdir(vscodeDir, { recursive: true })
        await writeFile(join(vscodeDir, 'tasks.json'), JSON.stringify({
          version: '2.0.0',
          tasks: [{
            label: 'TeamClaude: open terminal',
            type: 'shell',
            command: project.autorun,
            presentation: { reveal: 'always', focus: true, panel: 'new' },
            runOptions: { runOn: 'folderOpen' },
          }],
        }, null, 2), { flag: 'wx' }).catch(() => { /* exists — leave the user's file alone */ })
      }
      const child = spawn(settings.editorCommand, [path], { shell: true, detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('tc:settings:get', () => ({ ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }))
  ipcMain.handle('tc:settings:set', (_e, partial: Partial<AppSettings>) => {
    const next = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS), ...partial }
    store.set('settings', next)
    deps.applySettings(next)
    return next
  })

  ipcMain.handle('tc:window:setPinned', (_e, pinned: boolean) => deps.setPinned(pinned))
  ipcMain.handle('tc:window:hide', () => deps.getFlyout()?.hide())

  return () => disconnectEvents()
}
```

- [ ] **Step 6: Implement the preload bridge**

Replace `desktop/src/preload/index.ts`:

```ts
// desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

function on(channel: string) {
  return (cb: (payload: never) => void): (() => void) => {
    const listener = (_e: unknown, payload: never): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const tc = {
  proxy: {
    getState: () => ipcRenderer.invoke('tc:proxy:getState'),
    start: () => ipcRenderer.invoke('tc:proxy:start'),
    stop: () => ipcRenderer.invoke('tc:proxy:stop'),
    restart: () => ipcRenderer.invoke('tc:proxy:restart'),
    onState: on('tc:proxy-state'),
  },
  api: {
    status: () => ipcRenderer.invoke('tc:api:status'),
    recentEvents: () => ipcRenderer.invoke('tc:api:recentEvents'),
    reload: () => ipcRenderer.invoke('tc:api:reload'),
    oauthLogin: () => ipcRenderer.invoke('tc:api:oauthLogin'),
    onEvent: on('tc:event'),
  },
  config: {
    get: () => ipcRenderer.invoke('tc:config:get'),
    setAccountDisabled: (name: string, disabled: boolean) => ipcRenderer.invoke('tc:config:setAccountDisabled', name, disabled),
    setAccountPriority: (name: string, priority: number) => ipcRenderer.invoke('tc:config:setAccountPriority', name, priority),
    removeAccount: (name: string) => ipcRenderer.invoke('tc:config:removeAccount', name),
    setRoutes: (routes: unknown[]) => ipcRenderer.invoke('tc:config:setRoutes', routes),
  },
  launcher: {
    list: () => ipcRenderer.invoke('tc:launcher:list'),
    add: (p: unknown) => ipcRenderer.invoke('tc:launcher:add', p),
    remove: (path: string) => ipcRenderer.invoke('tc:launcher:remove', path),
    open: (path: string) => ipcRenderer.invoke('tc:launcher:open', path),
    pickFolder: () => ipcRenderer.invoke('tc:launcher:pickFolder'),
  },
  settings: {
    get: () => ipcRenderer.invoke('tc:settings:get'),
    set: (partial: unknown) => ipcRenderer.invoke('tc:settings:set', partial),
  },
  window: {
    setPinned: (pinned: boolean) => ipcRenderer.invoke('tc:window:setPinned', pinned),
    hide: () => ipcRenderer.invoke('tc:window:hide'),
  },
}

contextBridge.exposeInMainWorld('tc', tc)
export type TcBridge = typeof tc
```

Replace `desktop/src/preload/index.d.ts`:

```ts
import type { TcBridge } from './index'
declare global {
  interface Window { tc: TcBridge }
}
export {}
```

- [ ] **Step 7: Typecheck, test, commit**

Run: `cd desktop; npx tsc --noEmit -p tsconfig.json` (or `npm run typecheck` if the scaffold provides it) and `npm test`
Expected: clean.

```bash
git add desktop/src/main desktop/src/preload
git commit -m "feat(desktop): proxy client with SSE reconnect, IPC surface, preload bridge"
```

---

### Task 5: Tray, flyout window, hotkey, single instance (main bootstrap)

**Files:**
- Create: `desktop/src/main/flyout.ts`
- Create: `desktop/src/main/tray.ts`
- Replace: `desktop/src/main/index.ts`
- Create: `desktop/resources/tray-normal.png`, `tray-warn.png`, `tray-down.png` (16x16 + @2x; generate simple filled-circle PNGs — zinc dot, amber dot, red dot — with any image tool or script)

**Interfaces:**
- Consumes: Tasks 2-4 modules.
- Produces:
  - `createFlyout(): BrowserWindow` — frameless, 420 wide, work-area height, right edge, `alwaysOnTop`, `skipTaskbar`, hides on blur unless pinned. `toggleFlyout()`, `setPinned(pinned)` exported.
  - `createTray(opts: { onToggle: () => void; supervisor; onQuit: () => void }): Tray` — icon reflects supervisor state (`running/attached` → normal, `starting/crashed` → warn, `stopped` → down); context menu: Open, Start/Stop proxy, Launch at login (checkbox), Quit.
  - Main bootstrap wires: single-instance lock, supervisor autostart, global hotkey toggle, `applySettings` (hotkey re-registration + `app.setLoginItemSettings`), quit → `supervisor.stop()` when not `attached`.

- [ ] **Step 1: Implement the flyout window**

```ts
// desktop/src/main/flyout.ts
import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const WIDTH = 420
const MARGIN = 12

let flyout: BrowserWindow | null = null
let pinned = false

export function getFlyout(): BrowserWindow | null { return flyout }
export function setPinned(v: boolean): void { pinned = v }

export function createFlyout(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  flyout = new BrowserWindow({
    width: WIDTH,
    height: workArea.height - MARGIN * 2,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',   // Win11 flyout look; harmless elsewhere
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  flyout.on('blur', () => { if (!pinned) flyout?.hide() })
  flyout.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)          // oauth-url etc. open in the default browser
    return { action: 'deny' }
  })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    flyout.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    flyout.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return flyout
}

export function toggleFlyout(): void {
  if (!flyout) return
  if (flyout.isVisible()) { flyout.hide(); return }
  // Re-anchor in case display metrics changed since creation.
  const { workArea } = screen.getPrimaryDisplay()
  flyout.setBounds({
    width: WIDTH,
    height: workArea.height - MARGIN * 2,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
  })
  flyout.show()
  flyout.focus()
}
```

- [ ] **Step 2: Implement the tray**

```ts
// desktop/src/main/tray.ts
import { Tray, Menu, app, nativeImage } from 'electron'
import { join } from 'node:path'
import type { Supervisor, SupervisorState } from './supervisor'

const ICONS: Record<string, string> = {
  running: 'tray-normal.png', attached: 'tray-normal.png',
  starting: 'tray-warn.png', crashed: 'tray-warn.png',
  stopped: 'tray-down.png',
}

function icon(state: SupervisorState): Electron.NativeImage {
  return nativeImage.createFromPath(join(__dirname, '../../resources', ICONS[state] ?? 'tray-down.png'))
}

export function createTray(opts: { supervisor: Supervisor; onToggle: () => void; onQuit: () => void }): Tray {
  const { supervisor } = opts
  const tray = new Tray(icon(supervisor.state))
  tray.setToolTip('TeamClaude')

  const rebuild = (): void => {
    const running = supervisor.state === 'running' || supervisor.state === 'attached' || supervisor.state === 'starting'
    tray.setImage(icon(supervisor.state))
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open TeamClaude', click: opts.onToggle },
      { type: 'separator' },
      { label: `Proxy: ${supervisor.state}`, enabled: false },
      running
        ? { label: 'Stop proxy', click: () => void supervisor.stop() }
        : { label: 'Start proxy', click: () => void supervisor.start() },
      { label: 'Restart proxy', click: () => void supervisor.restart() },
      { type: 'separator' },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Quit', click: opts.onQuit },
    ]))
  }
  supervisor.on('state', rebuild)
  rebuild()
  tray.on('click', opts.onToggle)
  return tray
}
```

- [ ] **Step 3: Replace the main bootstrap**

```ts
// desktop/src/main/index.ts
import { app, globalShortcut } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import Store from 'electron-store'
import { Supervisor } from './supervisor'
import { ProxyClient } from './proxy-client'
import { readTeamclaudeConfig } from './teamclaude-config'
import { registerIpc, DEFAULT_SETTINGS, type AppSettings, type Project } from './ipc'
import { createFlyout, toggleFlyout, getFlyout, setPinned } from './flyout'
import { createTray } from './tray'

if (!app.requestSingleInstanceLock()) app.quit()

const store = new Store<{ settings: AppSettings; projects: Project[] }>()
let quitting = false

async function bootstrap(): Promise<void> {
  electronApp.setAppUserModelId('com.teamclaude.desktop')
  app.on('browser-window-created', (_e, win) => optimizer.watchWindowShortcuts(win))

  const cfg = await readTeamclaudeConfig()
  const port = cfg?.proxy.port ?? 3456
  const apiKey = cfg?.proxy.apiKey ?? ''
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }

  const supervisor = new Supervisor({
    command: settings.teamclaudeCommand,
    args: settings.teamclaudeArgs,
    port,
    apiKey,
  })
  const client = new ProxyClient({ port, apiKey })

  const applySettings = (s: AppSettings): void => {
    globalShortcut.unregisterAll()
    try { globalShortcut.register(s.hotkey, toggleFlyout) } catch { /* invalid accelerator — keep none */ }
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  }
  applySettings(settings)

  registerIpc({ supervisor, client, store, getFlyout, setPinned, applySettings })
  createFlyout()
  createTray({ supervisor, onToggle: toggleFlyout, onQuit: () => { quitting = true; app.quit() } })

  void supervisor.start()

  app.on('second-instance', toggleFlyout)
  app.on('before-quit', event => {
    // Own the child's lifetime: stop it on quit — unless we merely attached to
    // a proxy someone else started, which is theirs to manage.
    if (!quitting && supervisor.state !== 'stopped' && supervisor.state !== 'attached') {
      event.preventDefault()
      quitting = true
      void supervisor.stop().finally(() => app.quit())
    }
  })
  // Tray app: closing all windows must NOT quit.
  app.on('window-all-closed', () => { /* keep running in tray */ })
}

app.whenReady().then(bootstrap)
app.on('will-quit', () => globalShortcut.unregisterAll())
```

- [ ] **Step 4: Create the tray icons**

Generate three 16x16 dot PNGs in `desktop/resources/` with a dependency-free script (manual PNG chunk encoding — Node built-ins only):

```js
// desktop/scripts/gen-tray-icons.mjs — run once: node scripts/gen-tray-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function dotPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  const cx = (size - 1) / 2, radius = size * 0.34
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4) // filter byte 0 + RGBA pixels
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cx)
      const alpha = d <= radius ? 255 : d <= radius + 1 ? Math.round(255 * (radius + 1 - d)) : 0
      row.set([r, g, b, alpha], 1 + x * 4)
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync('resources', { recursive: true })
const colors = { 'tray-normal': [228, 228, 231], 'tray-warn': [245, 158, 11], 'tray-down': [239, 68, 68] }
for (const [name, rgb] of Object.entries(colors)) {
  writeFileSync(`resources/${name}.png`, dotPng(16, rgb))
  writeFileSync(`resources/${name}@2x.png`, dotPng(32, rgb))
}
console.log('tray icons written')
```

Run: `cd desktop; node scripts/gen-tray-icons.mjs`
Expected: six PNGs under `desktop/resources/`; opening one shows a soft-edged colored dot on transparency.

- [ ] **Step 5: Manual verification**

Run: `cd desktop; npm run dev`
Expected:
- A tray icon appears (no taskbar window).
- Left-click (and `Ctrl+Shift+Space`) toggles a frameless panel on the right edge; clicking elsewhere hides it.
- Tray menu shows proxy state transitioning `starting → running` (teamclaude must be installed/configured; otherwise `crashed` + backoff retries is the correct observable behavior).
- Quit stops the child (check with `teamclaude status` → connection refused) unless it attached.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main desktop/resources desktop/scripts
git commit -m "feat(desktop): tray, edge flyout window, global hotkey, single-instance bootstrap"
```

---

### Task 6: Renderer data layer (zustand store + bridge wiring)

**Files:**
- Create: `desktop/src/renderer/src/store.ts`
- Create: `desktop/src/renderer/src/types.ts`
- Test: `desktop/src/renderer/src/store.test.ts`

**Interfaces:**
- Consumes: `window.tc` (Task 4 contract).
- Produces: `useTcStore` zustand hook with state `{ proxyState, status, events, config, settings, projects }` and actions `{ init(), refreshStatus(), refreshConfig(), refreshProjects(), pushEvent(evt) }`. `pushEvent` dedupes by `evt.id`, caps `events` at 500 (newest last), and triggers `refreshStatus()` on `request-end` / `oauth-complete` (throttled to once per 2s). All views read from this store only.

- [ ] **Step 1: Write the failing test for pushEvent semantics**

```ts
// desktop/src/renderer/src/store.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTcStore } from './store'

beforeEach(() => {
  useTcStore.setState({ events: [], status: null })
  vi.stubGlobal('tc', undefined) // pushEvent must not require the bridge
})

describe('pushEvent', () => {
  it('appends events and dedupes by id', () => {
    const { pushEvent } = useTcStore.getState()
    pushEvent({ id: 1, type: 'request-start', ts: 1 })
    pushEvent({ id: 2, type: 'request-end', ts: 2 })
    pushEvent({ id: 1, type: 'request-start', ts: 1 })   // duplicate (SSE reconnect replay)
    expect(useTcStore.getState().events.map(e => e.id)).toEqual([1, 2])
  })

  it('caps the buffer at 500 events', () => {
    const { pushEvent } = useTcStore.getState()
    for (let i = 1; i <= 600; i++) pushEvent({ id: i, type: 'e', ts: i })
    const events = useTcStore.getState().events
    expect(events).toHaveLength(500)
    expect(events[0].id).toBe(101)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types and store**

```ts
// desktop/src/renderer/src/types.ts
export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }
export interface TcAccountStatus {
  name: string; type: string; orgName: string | null; priority: number
  disabled: boolean; status: string
  quota: Record<string, { utilization?: number; resetsAt?: string } | undefined>
  usage: Record<string, unknown>
  rateLimitedUntil: string | null
}
export interface TcStatus {
  currentAccount?: string
  switchThreshold?: number
  routes?: { name: string; match: string[]; accounts?: string[]; bucket?: string }[]
  accounts?: TcAccountStatus[]
  server?: { startedAt: string; uptimeSeconds: number; port: number; upstream: string }
  probe?: unknown
  warm?: unknown
}
export type SupervisorState = 'stopped' | 'starting' | 'running' | 'attached' | 'crashed'
```

```ts
// desktop/src/renderer/src/store.ts
import { create } from 'zustand'
import type { TcEvent, TcStatus, SupervisorState } from './types'

interface TcStore {
  proxyState: SupervisorState
  port: number
  status: TcStatus | null
  events: TcEvent[]
  config: unknown | null
  settings: Record<string, unknown> | null
  projects: { path: string; name: string; autorun: string | null }[]
  init: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshProjects: () => Promise<void>
  pushEvent: (evt: TcEvent) => void
}

let lastStatusRefresh = 0

export const useTcStore = create<TcStore>((set, get) => ({
  proxyState: 'stopped',
  port: 3456,
  status: null,
  events: [],
  config: null,
  settings: null,
  projects: [],

  init: async () => {
    const { state, port } = await window.tc.proxy.getState()
    set({ proxyState: state, port })
    window.tc.proxy.onState(s => {
      set({ proxyState: s })
      if (s === 'running' || s === 'attached') void get().refreshStatus()
    })
    window.tc.api.onEvent(evt => get().pushEvent(evt))
    await Promise.all([get().refreshStatus(), get().refreshConfig(), get().refreshProjects()])
    const settings = await window.tc.settings.get()
    set({ settings })
    const recent = await window.tc.api.recentEvents().catch(() => [])
    for (const e of recent) get().pushEvent(e)
  },

  refreshStatus: async () => {
    try { set({ status: (await window.tc.api.status()) as TcStatus }) }
    catch { set({ status: null }) }   // proxy down — views show the down state
  },

  refreshConfig: async () => {
    try { set({ config: await window.tc.config.get() }) } catch { set({ config: null }) }
  },

  refreshProjects: async () => {
    set({ projects: await window.tc.launcher.list() })
  },

  pushEvent: (evt: TcEvent) => {
    const { events } = get()
    if (events.some(e => e.id === evt.id)) return
    const next = [...events, evt]
    set({ events: next.length > 500 ? next.slice(next.length - 500) : next })
    if ((evt.type === 'request-end' || evt.type === 'oauth-complete') && Date.now() - lastStatusRefresh > 2000) {
      lastStatusRefresh = Date.now()
      void get().refreshStatus()
      if (evt.type === 'oauth-complete') void get().refreshConfig()
    }
  },
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop; npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/src/store.ts desktop/src/renderer/src/types.ts desktop/src/renderer/src/store.test.ts
git commit -m "feat(desktop): renderer store with SSE dedupe and status refresh throttling"
```

---

### Task 7: App shell + Dashboard + Accounts views

**Files:**
- Replace: `desktop/src/renderer/src/App.tsx`
- Create: `desktop/src/renderer/src/views/Dashboard.tsx`
- Create: `desktop/src/renderer/src/views/Accounts.tsx`
- Create: `desktop/src/renderer/src/components/QuotaBar.tsx`

**Interfaces:**
- Consumes: `useTcStore` (Task 6), `window.tc` for mutations, shadcn components from Task 1.
- Produces: flyout shell (header with pin/close + Tabs nav: Dashboard, Accounts, Routing, Activity, Launcher, Settings) rendering the two views. Later tasks add the remaining tab bodies; the shell already declares all six `TabsTrigger`s with placeholder `TabsContent` for the not-yet-built ones showing "Coming in a later task" text that Tasks 8-9 replace.

- [ ] **Step 1: App shell**

```tsx
// desktop/src/renderer/src/App.tsx
import { useEffect, useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Pin, PinOff, X } from 'lucide-react'
import { useTcStore } from './store'
import Dashboard from './views/Dashboard'
import Accounts from './views/Accounts'

const STATE_BADGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  running: { label: 'running', variant: 'default' },
  attached: { label: 'attached', variant: 'secondary' },
  starting: { label: 'starting…', variant: 'outline' },
  crashed: { label: 'crashed', variant: 'destructive' },
  stopped: { label: 'stopped', variant: 'destructive' },
}

export default function App(): React.JSX.Element {
  const { proxyState, init } = useTcStore()
  const [pinned, setPinnedState] = useState(false)
  useEffect(() => { void init() }, [init])

  const badge = STATE_BADGE[proxyState] ?? STATE_BADGE.stopped
  return (
    <div className="flex h-screen flex-col bg-background/95 text-foreground">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <span className="text-sm font-semibold tracking-tight">TeamClaude</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Pin panel"
            onClick={() => { const next = !pinned; setPinnedState(next); void window.tc.window.setPinned(next) }}>
            {pinned ? <Pin className="size-4" /> : <PinOff className="size-4 opacity-50" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Hide panel" onClick={() => void window.tc.window.hide()}>
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <Tabs defaultValue="dashboard" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3">
          <TabsTrigger value="dashboard">Home</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="routing">Routes</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="launcher">Projects</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="dashboard"><Dashboard /></TabsContent>
          <TabsContent value="accounts"><Accounts /></TabsContent>
          <TabsContent value="routing"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="activity"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="launcher"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
          <TabsContent value="settings"><p className="text-sm text-muted-foreground">Coming in a later task</p></TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 2: QuotaBar component**

```tsx
// desktop/src/renderer/src/components/QuotaBar.tsx
import { Progress } from '@renderer/components/ui/progress'

// quota entries look like { utilization: 0..1, resetsAt: ISO } per bucket
export default function QuotaBar({ label, utilization, resetsAt }: {
  label: string; utilization: number | undefined; resetsAt?: string
}): React.JSX.Element {
  const pct = Math.round((utilization ?? 0) * 100)
  const resets = resetsAt ? new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{pct}%{resets ? ` · resets ${resets}` : ''}</span>
      </div>
      <Progress value={pct} className={pct >= 98 ? '[&>div]:bg-destructive' : pct >= 80 ? '[&>div]:bg-amber-500' : ''} />
    </div>
  )
}
```

- [ ] **Step 3: Dashboard view**

```tsx
// desktop/src/renderer/src/views/Dashboard.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { RotateCw, Play, Square } from 'lucide-react'
import { useTcStore } from '../store'
import QuotaBar from '../components/QuotaBar'

export default function Dashboard(): React.JSX.Element {
  const { status, proxyState, events } = useTcStore()

  if (!status) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Proxy is not reachable</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Button size="sm" onClick={() => void window.tc.proxy.start()}><Play className="size-4" /> Start</Button>
          <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.restart()}><RotateCw className="size-4" /> Restart</Button>
        </CardContent>
      </Card>
    )
  }

  const recentEnds = events.filter(e => e.type === 'request-end').slice(-20)
  const uptime = status.server ? Math.floor(status.server.uptimeSeconds / 60) : 0

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Active account</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          <div className="text-lg font-medium">{status.currentAccount ?? '—'}</div>
          <div className="text-xs text-muted-foreground">
            port {status.server?.port} · up {uptime}m · {proxyState} · {recentEnds.length} recent requests
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => void window.tc.api.reload()}>
              <RotateCw className="size-4" /> Reload config
            </Button>
            <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.stop()}>
              <Square className="size-4" /> Stop proxy
            </Button>
          </div>
        </CardContent>
      </Card>

      {(status.accounts ?? []).map(a => (
        <Card key={a.name} className={a.name === status.currentAccount ? 'border-primary/50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {a.name}
              {a.disabled && <Badge variant="outline">disabled</Badge>}
              {a.status === 'error' && <Badge variant="destructive">error</Badge>}
              {a.rateLimitedUntil && <Badge variant="destructive">rate-limited</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(a.quota ?? {}).map(([bucket, q]) => (
              <QuotaBar key={bucket} label={bucket} utilization={q?.utilization} resetsAt={q?.resetsAt} />
            ))}
            {Object.keys(a.quota ?? {}).length === 0 && (
              <p className="text-xs text-muted-foreground">No quota observed yet</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Accounts view**

```tsx
// desktop/src/renderer/src/views/Accounts.tsx
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

export default function Accounts(): React.JSX.Element {
  const { config, events, refreshConfig } = useTcStore()
  const [loggingIn, setLoggingIn] = useState(false)
  const accounts = (config as { accounts?: { name: string; type: string; orgName?: string | null; priority?: number; disabled?: boolean }[] } | null)?.accounts ?? []

  const lastOauth = [...events].reverse().find((e: TcEvent) => e.type.startsWith('oauth-'))
  const oauthBusy = loggingIn && lastOauth?.type !== 'oauth-complete' && lastOauth?.type !== 'oauth-error'

  const addAccount = async (): Promise<void> => {
    setLoggingIn(true)
    const r = await window.tc.api.oauthLogin()
    if (!r.ok) setLoggingIn(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{accounts.length} account(s)</h2>
        <Button size="sm" onClick={() => void addAccount()} disabled={oauthBusy}>
          {oauthBusy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add account
        </Button>
      </div>
      {lastOauth?.type === 'oauth-error' && (
        <p className="text-xs text-destructive">Login failed: {String(lastOauth.error)}</p>
      )}
      {oauthBusy && (
        <p className="text-xs text-muted-foreground">Complete the login in your browser…</p>
      )}
      {accounts.map(a => (
        <Card key={a.name}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              {a.name}
              <Badge variant="secondary">{a.type}</Badge>
              {a.orgName && <Badge variant="outline">{a.orgName}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={!a.disabled}
                onCheckedChange={async v => { await window.tc.config.setAccountDisabled(a.name, !v); await refreshConfig() }} />
              enabled
            </label>
            <label className="flex items-center gap-2 text-xs">
              priority
              <Input type="number" defaultValue={a.priority ?? 0} className="h-7 w-16"
                onBlur={async e => { await window.tc.config.setAccountPriority(a.name, Number(e.target.value) || 0); await refreshConfig() }} />
            </label>
            <Button variant="ghost" size="icon" className="ml-auto text-destructive" aria-label={`Remove ${a.name}`}
              onClick={async () => {
                if (!window.confirm(`Remove account "${a.name}"? The proxy will restart.`)) return
                await window.tc.config.removeAccount(a.name)
                await refreshConfig()
              }}>
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Manual verification**

Run: `cd desktop; npm run dev` with the proxy configured.
Expected: flyout shows proxy badge, active account, per-account quota bars; Accounts tab lists accounts; toggle enable/disable flips `disabled` in `~/.config/teamclaude.json` and the proxy picks it up (verify with `teamclaude status`); "Add account" opens the browser OAuth flow and the new account appears on completion.

- [ ] **Step 6: Typecheck and commit**

Run: `cd desktop; npx tsc --noEmit`

```bash
git add desktop/src/renderer
git commit -m "feat(desktop): flyout shell, dashboard and accounts views"
```

---

### Task 8: Activity + Routing views

**Files:**
- Create: `desktop/src/renderer/src/views/Activity.tsx`
- Create: `desktop/src/renderer/src/views/Routing.tsx`
- Modify: `desktop/src/renderer/src/App.tsx` (replace the two placeholder `TabsContent` bodies with `<Activity />` / `<Routing />` and add the imports)

**Interfaces:**
- Consumes: store events (`request-*` types carry `reqId`, `method`, `path`, `model?`, `account?`, `status?`), `window.tc.config.setRoutes(routes)`, status `routes` array `{ name, match: string[], accounts?: string[], bucket?: string }`.
- Produces: live activity feed; routes CRUD editor.

- [ ] **Step 1: Activity view**

```tsx
// desktop/src/renderer/src/views/Activity.tsx
import { useMemo, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

interface RequestRow { reqId: number; ts: number; method?: string; path?: string; model?: string; account?: string; status?: number; done: boolean }

// Fold the request-* event stream into one row per request id.
export function foldRequests(events: TcEvent[]): RequestRow[] {
  const rows = new Map<number, RequestRow>()
  for (const e of events) {
    if (!e.type.startsWith('request-')) continue
    const reqId = e.reqId as number
    const row = rows.get(reqId) ?? { reqId, ts: e.ts, done: false }
    if (e.type === 'request-start') Object.assign(row, { method: e.method, path: e.path })
    if (e.type === 'request-model') row.model = e.model as string
    if (e.type === 'request-routed') row.account = e.account as string
    if (e.type === 'request-end') Object.assign(row, { status: e.status, account: e.account ?? row.account, model: e.model ?? row.model, done: true })
    rows.set(reqId, row)
  }
  return [...rows.values()].sort((a, b) => b.ts - a.ts)
}

export default function Activity(): React.JSX.Element {
  const { events } = useTcStore()
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const all = foldRequests(events)
    if (!filter) return all
    const f = filter.toLowerCase()
    return all.filter(r => [r.path, r.model, r.account, String(r.status)].some(v => v?.toLowerCase().includes(f)))
  }, [events, filter])

  return (
    <div className="space-y-2">
      <Input placeholder="Filter by path, model, account, status…" value={filter} onChange={e => setFilter(e.target.value)} className="h-8" />
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No requests yet.</p>}
      <ul className="space-y-1">
        {rows.slice(0, 100).map(r => (
          <li key={r.reqId} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
            {!r.done ? <Badge variant="outline" className="animate-pulse">···</Badge>
              : <Badge variant={r.status && r.status < 400 ? 'secondary' : 'destructive'}>{r.status ?? '?'}</Badge>}
            <span className="truncate font-mono">{r.model ?? r.path ?? '—'}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{r.account ?? ''}</span>
            <span className="shrink-0 text-muted-foreground">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Routing view**

```tsx
// desktop/src/renderer/src/views/Routing.tsx
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Plus, Trash2, Save } from 'lucide-react'
import { useTcStore } from '../store'

interface Route { name: string; match: string[]; accounts?: string[]; bucket?: string }

export default function Routing(): React.JSX.Element {
  const { status, refreshStatus } = useTcStore()
  const [routes, setRoutes] = useState<Route[]>([])
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setRoutes(status?.routes ?? []) }, [status, dirty])

  const edit = (i: number, patch: Partial<Route>): void => {
    setRoutes(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const save = async (): Promise<void> => {
    const clean = routes
      .filter(r => r.name.trim() && r.match.length)
      .map(r => ({ ...r, accounts: r.accounts?.length ? r.accounts : undefined, bucket: r.bucket || undefined }))
    await window.tc.config.setRoutes(clean)
    setDirty(false)
    await refreshStatus()
  }
  const csv = (v: string[] | undefined): string => (v ?? []).join(', ')
  const parse = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">First matching route wins. Empty accounts = all accounts.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setRoutes(r => [...r, { name: '', match: [] }]); setDirty(true) }}>
            <Plus className="size-4" /> Route
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty}><Save className="size-4" /> Save</Button>
        </div>
      </div>
      {routes.map((r, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-sm">
              <Input value={r.name} placeholder="route name" className="h-7 w-40" onChange={e => edit(i, { name: e.target.value })} />
              <Button variant="ghost" size="icon" className="ml-auto text-destructive" aria-label="Delete route"
                onClick={() => { setRoutes(rs => rs.filter((_x, j) => j !== i)); setDirty(true) }}>
                <Trash2 className="size-4" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="space-y-1">
              <Label className="text-xs">Model globs (comma-separated)</Label>
              <Input value={csv(r.match)} placeholder="claude-opus-*, claude-fable-*" className="h-7"
                onChange={e => edit(i, { match: parse(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Accounts (comma-separated names; empty = all)</Label>
              <Input value={csv(r.accounts)} className="h-7" onChange={e => edit(i, { accounts: parse(e.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Quota bucket (optional)</Label>
              <Input value={r.bucket ?? ''} className="h-7" onChange={e => edit(i, { bucket: e.target.value })} />
            </div>
          </CardContent>
        </Card>
      ))}
      {routes.length === 0 && <p className="text-sm text-muted-foreground">No routes — all models rotate across all accounts.</p>}
    </div>
  )
}
```

- [ ] **Step 3: Wire into App.tsx**

In `desktop/src/renderer/src/App.tsx` add imports `import Activity from './views/Activity'` and `import Routing from './views/Routing'`, and replace the two placeholder `TabsContent` bodies:

```tsx
          <TabsContent value="routing"><Routing /></TabsContent>
          <TabsContent value="activity"><Activity /></TabsContent>
```

- [ ] **Step 4: Manual verification**

Run: `cd desktop; npm run dev`, then send traffic through the proxy (`teamclaude run -- -p "hi"`).
Expected: Activity rows appear live with model, account, status; filter narrows. Add a route, Save, then `teamclaude route list` shows it; delete it from the UI and `route list` confirms removal.

- [ ] **Step 5: Typecheck and commit**

Run: `cd desktop; npx tsc --noEmit; npm test`

```bash
git add desktop/src/renderer
git commit -m "feat(desktop): live activity feed and per-model routing editor"
```

---

### Task 9: Launcher + Settings views

**Files:**
- Create: `desktop/src/renderer/src/views/Launcher.tsx`
- Create: `desktop/src/renderer/src/views/Settings.tsx`
- Modify: `desktop/src/renderer/src/App.tsx` (imports + last two placeholders)

**Interfaces:**
- Consumes: `window.tc.launcher.*`, `window.tc.settings.*` (Task 4 contract). `Project = { path, name, autorun: string | null }`.
- Produces: project list with "Open in Trae"; settings form (editor command, hotkey, launch at login, teamclaude command).

- [ ] **Step 1: Launcher view**

```tsx
// desktop/src/renderer/src/views/Launcher.tsx
import { useState } from 'react'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { FolderOpen, Plus, Trash2, ExternalLink } from 'lucide-react'
import { useTcStore } from '../store'

export default function Launcher(): React.JSX.Element {
  const { projects, refreshProjects } = useTcStore()
  const [error, setError] = useState<string | null>(null)
  const [autoTerminal, setAutoTerminal] = useState(true)
  // teamclaude run launches claude with the proxy env (ANTHROPIC_BASE_URL /
  // MITM) already handled — see src/index.js runCommand.
  const [autorunCmd, setAutorunCmd] = useState('teamclaude run')

  const addProject = async (): Promise<void> => {
    const path = await window.tc.launcher.pickFolder()
    if (!path) return
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
    await window.tc.launcher.add({ path, name, autorun: autoTerminal ? autorunCmd : null })
    await refreshProjects()
  }
  const open = async (path: string): Promise<void> => {
    setError(null)
    const r = await window.tc.launcher.open(path)
    if (!r.ok) setError(r.error ?? 'Failed to open editor')
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Auto-open terminal running:</Label>
            <Switch checked={autoTerminal} onCheckedChange={setAutoTerminal} />
          </div>
          {autoTerminal && (
            <Input value={autorunCmd} onChange={e => setAutorunCmd(e.target.value)} className="h-7 font-mono" />
          )}
          <Button size="sm" className="w-full" onClick={() => void addProject()}>
            <Plus className="size-4" /> Add project folder
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Auto-terminal writes a one-time .vscode/tasks.json (folderOpen task) into the project.
            The editor asks once to allow automatic tasks.
          </p>
        </CardContent>
      </Card>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {projects.map(p => (
        <Card key={p.path}>
          <CardContent className="flex items-center gap-2 py-3">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground">{p.path}{p.autorun ? ` · runs ${p.autorun}` : ''}</div>
            </div>
            <Button size="sm" className="ml-auto shrink-0" onClick={() => void open(p.path)}>
              <ExternalLink className="size-4" /> Open
            </Button>
            <Button variant="ghost" size="icon" className="shrink-0 text-destructive" aria-label={`Remove ${p.name}`}
              onClick={async () => { await window.tc.launcher.remove(p.path); await refreshProjects() }}>
              <Trash2 className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
      {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects yet — add a folder to launch it in your editor.</p>}
    </div>
  )
}
```

- [ ] **Step 2: Settings view**

```tsx
// desktop/src/renderer/src/views/Settings.tsx
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Save } from 'lucide-react'

interface AppSettings {
  editorCommand: string; hotkey: string; launchAtLogin: boolean
  teamclaudeCommand: string; teamclaudeArgs: string[]
}

export default function Settings(): React.JSX.Element {
  const [s, setS] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { void window.tc.settings.get().then(v => setS(v as AppSettings)) }, [])
  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>

  const save = async (): Promise<void> => {
    await window.tc.settings.set(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  const field = (label: string, key: 'editorCommand' | 'hotkey' | 'teamclaudeCommand', mono = true): React.JSX.Element => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={s[key]} className={`h-7 ${mono ? 'font-mono' : ''}`}
        onChange={e => setS({ ...s, [key]: e.target.value })} />
    </div>
  )

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">App</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {field('Editor command (Trae CLI)', 'editorCommand')}
          {field('Toggle hotkey (Electron accelerator)', 'hotkey')}
          <div className="flex items-center justify-between">
            <Label className="text-xs">Launch at login</Label>
            <Switch checked={s.launchAtLogin} onCheckedChange={v => setS({ ...s, launchAtLogin: v })} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Proxy process</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {field('teamclaude command', 'teamclaudeCommand')}
          <div className="space-y-1">
            <Label className="text-xs">Arguments (space-separated)</Label>
            <Input value={s.teamclaudeArgs.join(' ')} className="h-7 font-mono"
              onChange={e => setS({ ...s, teamclaudeArgs: e.target.value.split(/\s+/).filter(Boolean) })} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Dev checkout example: command <code>node</code>, args <code>C:\code\teamclaude\src\index.js server --headless</code>.
            Command changes apply on the next proxy restart.
          </p>
        </CardContent>
      </Card>
      <Button size="sm" onClick={() => void save()}><Save className="size-4" /> {saved ? 'Saved' : 'Save settings'}</Button>
    </div>
  )
}
```

- [ ] **Step 3: Wire into App.tsx**

Add imports `import Launcher from './views/Launcher'` and `import Settings from './views/Settings'`; replace the last two placeholders:

```tsx
          <TabsContent value="launcher"><Launcher /></TabsContent>
          <TabsContent value="settings"><Settings /></TabsContent>
```

- [ ] **Step 4: Manual verification**

Run: `cd desktop; npm run dev`
Expected: add this repo as a project with auto-terminal `claude`; "Open" launches Trae on the folder, and (after allowing automatic tasks once in Trae) a terminal panel opens running `claude`. Settings: change hotkey to `Control+Shift+T`, save, verify the new hotkey toggles the flyout; toggle launch-at-login and verify in Task Manager → Startup apps.

- [ ] **Step 5: Typecheck and commit**

Run: `cd desktop; npx tsc --noEmit; npm test`

```bash
git add desktop/src/renderer
git commit -m "feat(desktop): project launcher (Trae + auto-terminal task) and settings views"
```

---

### Task 10: Visual polish pass (Shadcn Studio + design skills)

**Files:**
- Modify: all files under `desktop/src/renderer/src/` (views, components, `main.css` theme tokens)

**Interfaces:**
- Consumes: the working baseline UI from Tasks 7-9. No behavioral changes — only presentation. All `window.tc` calls and store selectors stay exactly as-is.

This task is interactive by nature (design iteration), so its steps are workflows, not code blocks:

- [ ] **Step 1: Establish the theme**

Apply a dark-first theme: either `npx shadcn@latest add @ss-themes/<chosen-theme>` from Shadcn Studio, or hand-tune the CSS variables in `main.css`. Constraints: dark-mode-first tray-utility aesthetic, distinctive (not default zinc), readable at 420px width, `bg-background/95` kept translucent so the acrylic window material shows through.

- [ ] **Step 2: Upgrade components with Shadcn Studio**

Use the `/rui` (refine) and `/cui` (create) commands with the shadcn-studio MCP server per view: dashboard stat/quota cards, account list items, activity feed rows, settings forms. Follow the `frontend-design` skill for typography/spacing decisions. Keep every existing prop/handler intact.

- [ ] **Step 3: Motion**

Add entrance transitions (flyout content fade/slide on mount, ~150ms), animated progress bars, and a subtle pulse on the in-flight activity badge. CSS transitions only — no animation library.

- [ ] **Step 4: Verify no regressions**

Run: `cd desktop; npx tsc --noEmit; npm test` and click through every tab against a running proxy.
Expected: all functionality from Tasks 7-9 still works; no console errors.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer
git commit -m "feat(desktop): visual polish pass — theme, studio components, motion"
```

---

### Task 11: Packaging (electron-builder, Windows)

**Files:**
- Create: `desktop/electron-builder.yml`
- Modify: `desktop/package.json` (build scripts, productName, version)
- Create: `desktop/build/icon.ico` (256px app icon; generate from the tray dot motif)

**Interfaces:**
- Consumes: the complete app.
- Produces: `npm run build:win` → NSIS installer + portable exe under `desktop/dist/`.

- [ ] **Step 1: Builder config**

```yaml
# desktop/electron-builder.yml
appId: com.teamclaude.desktop
productName: TeamClaude
directories:
  buildResources: build
files:
  - out/**
  - resources/**
win:
  target:
    - nsis
    - portable
  icon: build/icon.ico
nsis:
  oneClick: true
  runAfterFinish: true
```

- [ ] **Step 2: Scripts**

In `desktop/package.json` ensure:

```json
{
  "scripts": {
    "build": "electron-vite build",
    "build:win": "electron-vite build && electron-builder --win"
  }
}
```

- [ ] **Step 3: Build and smoke-test**

Run: `cd desktop; npm run build:win`
Expected: installer under `desktop/dist/`. Install it, launch, verify: tray appears, flyout opens, proxy starts (with `teamclaude` on PATH or the configured command), launch-at-login works from the packaged app.

- [ ] **Step 4: Commit**

```bash
git add desktop/electron-builder.yml desktop/package.json desktop/build
git commit -m "feat(desktop): electron-builder packaging for Windows"
```
