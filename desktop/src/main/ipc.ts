import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { spawn, execSync, execFile } from 'node:child_process'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Store from 'electron-store'
import { logLine } from './log'
import type { Supervisor } from './supervisor'
import { ProxyClient, type TcEvent } from './proxy-client'
import { readTeamclaudeConfig, updateTeamclaudeConfig, redactConfig, type TcRoute } from './teamclaude-config'
import { isTeamclaudeInstalled, installTeamclaude } from './teamclaude-install'
import { refreshTrayMenu } from './tray'

export interface Project { path: string; name: string; autorun: string | null }
export interface AppSettings {
  editorCommand: string
  hotkey: string
  launchAtLogin: boolean
  teamclaudeCommand: string
  teamclaudeArgs: string[]
  autoRoute?: boolean
  claudeFlags?: string[]   // Claude Code CLI flags appended to the auto-terminal's `teamclaude run` command
  showDock?: boolean       // opt-in edge dock (micro-HUD) — persisted, off by default
  dockOpacity?: number     // edge dock window opacity [0.25, 1]
  onboarded?: boolean      // first-run walkthrough completed/skipped — omitted (falsy) until then
}

export const DEFAULT_SETTINGS: AppSettings = {
  editorCommand: 'trae',
  hotkey: 'Control+Shift+Space',
  launchAtLogin: false,
  teamclaudeCommand: 'teamclaude',
  teamclaudeArgs: ['server', '--headless'],
  autoRoute: false,
  claudeFlags: [],
  showDock: false,
  dockOpacity: 1,
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise(resolve => { execFile(cmd, args, { windowsHide: true }, () => resolve()) })
}

/**
 * Persist ANTHROPIC_BASE_URL as a user env var so every NEW terminal's `claude`
 * routes through this proxy automatically — no per-session command. Enabling
 * uses `setx`; disabling removes the var from the user environment. Applies to
 * new processes only (not already-open terminals).
 */
export async function applyAutoRoute(enabled: boolean, url: string): Promise<void> {
  if (enabled) await runCmd('setx', ['ANTHROPIC_BASE_URL', url])
  else await runCmd('reg', ['delete', 'HKCU\\Environment', '/v', 'ANTHROPIC_BASE_URL', '/f'])
}

export interface ProxyInfo { port: number; url: string; configPath: string }

export interface IpcDeps {
  supervisor: Supervisor
  client: ProxyClient
  store: Store<{ settings: AppSettings; projects: Project[] }>
  getFlyout: () => BrowserWindow | null
  setPinned: (pinned: boolean) => void
  setCompact: (on: boolean) => void         // shrink the flyout into the HUD and back
  minimizeFlyout: () => void                 // minimize the flyout to the taskbar
  toggleDock: (on: boolean) => void         // create/show or destroy the edge dock (micro-HUD)
  setDockExpanded: (on: boolean) => void    // resize the dock between collapsed tab / expanded panel
  setDockOpacity: (v: number) => void       // set the dock window's transparency [0.25, 1]
  isDockOpen: () => boolean                 // whether the dock window currently exists
  applySettings: (s: AppSettings) => void   // re-register hotkey, login item (Task 5)
  proxyInfo: ProxyInfo                        // the app-owned proxy's port/url/configPath
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

/**
 * Resolve the editor command to a launchable executable. Returns null when it
 * can't be found — so the launcher reports a real error instead of silently
 * "succeeding" through a shell (the old `shell:true` masked a missing `trae`).
 * Order: an explicit existing path → the command on PATH → known install for a
 * preset keyword ("trae" / "synara").
 */
function resolveEditorExe(editorCommand: string): string | null {
  const cmd = editorCommand.trim()
  // 1. An explicit path the user typed (absolute or with an extension).
  if ((cmd.includes('\\') || cmd.includes('/') || /\.(exe|cmd|bat)$/i.test(cmd)) && existsSync(cmd)) {
    return cmd
  }
  // 2. A bare command that's actually on PATH.
  try {
    const found = execSync(`where "${cmd}"`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/)[0]
    if (found && existsSync(found)) return found
  } catch { /* not on PATH */ }
  // 3. Known installs for the preset keywords — covers "trae"/"synara" when the
  //    app's CLI shim was never added to PATH.
  const local = process.env.LOCALAPPDATA
  if (local) {
    if (/synara/i.test(cmd)) {
      const c = join(local, 'Programs', 'synara-desktop', 'Synara.exe')
      if (existsSync(c)) return c
    }
    if (/trae/i.test(cmd)) {
      const candidates = [join(local, 'Programs', 'Trae', 'Trae.exe'), join(local, 'Programs', 'Trae CN', 'Trae CN.exe')]
      for (const c of candidates) if (existsSync(c)) return c
    }
  }
  return null
}

/**
 * Whether an editor reads `.vscode/tasks.json` — i.e. VS Code-family editors
 * (Trae, VS Code, Cursor, Windsurf, VSCodium). Synara and other non-VS-Code
 * editors don't, so the folderOpen auto-terminal is skipped for them; their
 * Claude still routes here via Auto-route's ANTHROPIC_BASE_URL env var.
 */
function isVsCodeFamilyEditor(editorCommand: string): boolean {
  const c = editorCommand.trim().toLowerCase()
  if (/synara/.test(c)) return false
  return /(trae|cursor|windsurf|codium|vscode|\bcode\b)/.test(c)
}

export function registerIpc(deps: IpcDeps): () => void {
  const { supervisor, client, store } = deps

  supervisor.on('state', s => broadcast('tc:proxy-state', s))
  // The proxy tries to open the OAuth URL itself, but as a windowsHide child it
  // cannot reliably surface a browser window — the login "did nothing". Open it
  // from the app as well. lastOauthUrl guards against SSE reconnect replays
  // re-opening the same flow; a rare duplicate tab beats an invisible login.
  let lastOauthUrl = ''
  const disconnectEvents = client.connectEvents((evt: TcEvent) => {
    if (evt.type === 'oauth-url') {
      const url = (evt as { url?: string }).url
      if (url && url !== lastOauthUrl && url.startsWith('https://')) {
        lastOauthUrl = url
        void shell.openExternal(url)
      }
    }
    broadcast('tc:event', evt)
  })

  ipcMain.handle('tc:proxy:getState', async () => {
    const cfg = await readTeamclaudeConfig()
    return { state: supervisor.state, port: cfg?.proxy.port ?? 3456, recentLog: supervisor.lastLogLines }
  })
  ipcMain.handle('tc:proxy:start', () => supervisor.start())
  ipcMain.handle('tc:proxy:stop', () => supervisor.stop())
  ipcMain.handle('tc:proxy:restart', () => supervisor.restart())

  // Onboarding: ensure a real global `teamclaude` install, streaming npm output.
  ipcMain.handle('tc:install:status', () => isTeamclaudeInstalled())
  ipcMain.handle('tc:install:run', async () => {
    const r = await installTeamclaude(line => broadcast('tc:install-log', line))
    if (r.ok) broadcast('tc:install-log', '✓ teamclaude installed')
    return r
  })

  ipcMain.handle('tc:api:status', () => client.status())
  ipcMain.handle('tc:api:recentEvents', () => client.recentEvents())
  ipcMain.handle('tc:api:reload', () => client.reload())
  ipcMain.handle('tc:api:oauthLogin', () => client.oauthLogin())
  ipcMain.handle('tc:account:pin', async (_e, token: string | null) => {
    const r = await client.pinAccount(token)
    return r
  })

  ipcMain.handle('tc:config:get', async () => {
    const cfg = await readTeamclaudeConfig()
    return cfg ? redactConfig(cfg) : null
  })
  // Account disable/priority → POST /teamclaude/account, targeting the stable id
  // when the caller has one (name fallback). Per Phase-0 §5c the endpoint applies
  // disk + runtime atomically before returning 200, so no extra reload.
  //
  // Fallback is gated on TRUE endpoint-absence ONLY: `r.supported === false` is
  // set exclusively by a 404 (no such endpoint on an older server). Any other
  // non-2xx — notably a 400 {error:'unknown_account'} — comes back supported:true
  // and is returned as an error to the renderer; it must NEVER trigger a config
  // write (that would resurrect the corruption the endpoint was built to avoid).
  ipcMain.handle('tc:account:set', async (_e, target: string, patch: { disabled?: boolean; priority?: number }) => {
    const r = await client.setAccount(target, patch)
    if (r.supported) return r
    // Legacy direct config write (older server, endpoint 404-absent). The patch
    // arrives over IPC from the renderer, so validate its shape before writing to
    // disk — reject a non-finite priority or a non-boolean disabled outright.
    if (patch.priority !== undefined && (typeof patch.priority !== 'number' || !Number.isFinite(patch.priority))) {
      throw new Error('priority must be a finite number')
    }
    if (patch.disabled !== undefined && typeof patch.disabled !== 'boolean') {
      throw new Error('disabled must be a boolean')
    }
    await updateTeamclaudeConfig(cfg => {
      const a = cfg.accounts.find(x => x.name === target)
      if (!a) throw new Error(`No account named "${target}"`)
      if (patch.disabled !== undefined) { if (patch.disabled) a.disabled = true; else delete a.disabled }
      if (patch.priority !== undefined) a.priority = patch.priority
    })
    await client.reload()
    return { ok: true, supported: false }
  })
  ipcMain.handle('tc:config:removeAccount', async (_e, name: string) => {
    await updateTeamclaudeConfig(cfg => {
      cfg.accounts = cfg.accounts.filter(x => x.name !== name)
    })
    await supervisor.restart()   // removals don't apply via reload (see src/index.js notifyRunningServer docs)
  })
  // Routes read/write go through the dedicated Phase-0 endpoints ONLY — never a
  // config-file write, never the /status display DTO. That closes the B5
  // corruption loop where {name,eligible} objects were written back as accounts.
  ipcMain.handle('tc:routes:get', () => client.getRoutes())
  ipcMain.handle('tc:routes:set', (_e, routes: TcRoute[]) => client.setRoutes(routes))
  ipcMain.handle('tc:config:setSx', async (_e, sx: { apiKey?: string; mode: string }) => {
    await updateTeamclaudeConfig(cfg => {
      const mode = sx.mode
      // Preserve the existing key when the UI sends an empty apiKey (masked field
      // left untouched); only overwrite when a new key is actually provided.
      const apiKey = sx.apiKey && sx.apiKey.trim() ? sx.apiKey.trim() : cfg.sx?.apiKey
      cfg.sx = { ...(apiKey ? { apiKey } : {}), mode }
    })
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
      // Auto-terminal (opt-in per project via autorun): a folderOpen task that
      // runs `teamclaude run` in the editor's integrated terminal. Claude MUST
      // be launched through teamclaude — auto-route alone does not fully cover
      // Claude Code's traffic in practice — so the launcher makes routed
      // launching the default path. Note: an editor task fires on every open of
      // the folder, including manual ones; that is inherent to editor tasks and
      // the reason autorun is per-project opt-in.
      if (project?.autorun && isVsCodeFamilyEditor(settings.editorCommand)) {
        const raw = (project?.autorun ?? '').trim()
        const flags = settings.claudeFlags ?? []
        // Route through `teamclaude run` — identical to how the user runs it in
        // the CLI (it sets up the proxy/MITM and forwards flags to claude).
        // Default when no custom command is set; migrate the legacy 'claude'.
        const base = raw && raw !== 'claude' ? raw : 'teamclaude run'
        const runCmd = [base, ...flags].join(' ')
        const task = {
          label: 'TeamClaude: open terminal',
          type: 'shell',
          command: runCmd,
          presentation: { reveal: 'always', focus: true, panel: 'new' },
          runOptions: { runOn: 'folderOpen' },
        }
        const vscodeDir = join(path, '.vscode')
        await mkdir(vscodeDir, { recursive: true })
        const tasksPath = join(vscodeDir, 'tasks.json')
        // Merge into an existing tasks.json — keep the user's other tasks and
        // replace (or insert) our labelled one. A missing file is written
        // fresh; an unparseable one is backed up to tasks.json.bak first so
        // hand-written config is never silently destroyed.
        let out: { version: string; tasks: unknown[] } = { version: '2.0.0', tasks: [task] }
        let existing: string | null = null
        try { existing = await readFile(tasksPath, 'utf8') } catch { /* missing — write fresh */ }
        if (existing !== null) {
          try {
            const parsed = JSON.parse(existing) as { version?: string; tasks?: unknown[] }
            const others = Array.isArray(parsed.tasks)
              ? parsed.tasks.filter(t => (t as { label?: string } | null)?.label !== task.label)
              : []
            out = { version: parsed.version ?? '2.0.0', tasks: [...others, task] }
          } catch {
            await writeFile(`${tasksPath}.bak`, existing).catch(() => { /* best-effort backup */ })
          }
        }
        await writeFile(tasksPath, JSON.stringify(out, null, 2)).catch(() => { /* best-effort */ })
      }
      const exe = resolveEditorExe(settings.editorCommand)
      if (!exe) {
        return { ok: false, error: `Editor "${settings.editorCommand}" not found. Pick Trae or Synara in Settings, or set the full path to its .exe.` }
      }
      // A .cmd/.bat shim needs a shell; a real .exe is launched directly so a
      // failure surfaces as an error rather than being swallowed by the shell.
      // cwd is set to the project explicitly — otherwise the editor inherits the
      // APP's working directory (the packaged win-unpacked folder when launched
      // from a shortcut) and holds a CWD lock on it, breaking every rebuild.
      const useShell = /\.(cmd|bat)$/i.test(exe)
      const child = spawn(exe, [path], { shell: useShell, detached: true, stdio: 'ignore', cwd: path })
      child.on('error', () => { /* reported below via ok:false is not possible post-detach; logged */ })
      child.unref()
      return { ok: true, editor: exe }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Launch Synara directly (no project) — the home-screen quick button. Synara
  // has a single-instance lock, so a second launch just focuses the existing
  // window; that's the intended "open Synara" behavior. cwd is the user's home
  // so we never hold a lock on the packaged app dir (see tc:launcher:open note).
  ipcMain.handle('tc:launcher:openSynara', async () => {
    try {
      const exe = resolveEditorExe('synara')
      if (!exe) {
        return { ok: false, error: 'Synara not found. Install it, or set its full path as a Custom editor in Settings.' }
      }
      const home = process.env.USERPROFILE || process.env.HOME || undefined
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', ...(home ? { cwd: home } : {}) })
      child.on('error', () => { /* detached — surfaced via ok:false only pre-spawn */ })
      child.unref()
      return { ok: true, editor: exe }
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

  ipcMain.handle('tc:proxy:getInfo', () => deps.proxyInfo)

  ipcMain.handle('tc:proxy:getAutoRoute', () => {
    const s = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }
    return { enabled: !!s.autoRoute, url: deps.proxyInfo.url }
  })
  ipcMain.handle('tc:proxy:setAutoRoute', async (_e, enabled: boolean) => {
    await applyAutoRoute(enabled, deps.proxyInfo.url)
    const s = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS), autoRoute: enabled }
    store.set('settings', s)
    return { ok: true, enabled }
  })

  ipcMain.handle('tc:window:setPinned', (_e, pinned: boolean) => deps.setPinned(pinned))
  ipcMain.handle('tc:window:setCompact', (_e, on: boolean) => deps.setCompact(on))
  ipcMain.handle('tc:window:hide', () => deps.getFlyout()?.hide())
  ipcMain.handle('tc:window:minimize', () => deps.minimizeFlyout())

  ipcMain.handle('tc:dock:toggle', (_e, on: boolean) => { deps.toggleDock(on); refreshTrayMenu() })
  ipcMain.handle('tc:dock:setExpanded', (_e, on: boolean) => deps.setDockExpanded(on))
  ipcMain.handle('tc:dock:setOpacity', (_e, v: number) => deps.setDockOpacity(v))
  ipcMain.handle('tc:dock:isOpen', () => deps.isDockOpen())

  // Fire-and-forget renderer -> main log line (e.g. ErrorBoundary reports).
  // Bounds on source/line length keep a misbehaving renderer from flooding
  // the on-disk log; unrecognized shapes are silently dropped.
  ipcMain.on('tc:log', (_e, source: unknown, line: unknown) => {
    if (typeof source === 'string' && typeof line === 'string') {
      logLine(`renderer:${source.slice(0, 32)}`, line.slice(0, 2000))
    }
  })

  return () => disconnectEvents()
}
