import { ipcMain, dialog, BrowserWindow } from 'electron'
import { spawn, execSync, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Store from 'electron-store'
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
 * Order: an explicit existing path → the command on PATH → known Trae install.
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
  // 3. Known Trae install (VS Code-family layout) — covers the default "trae"
  //    when its CLI shim was never added to PATH.
  if (/trae/i.test(cmd)) {
    const local = process.env.LOCALAPPDATA
    const candidates = local
      ? [join(local, 'Programs', 'Trae', 'Trae.exe'), join(local, 'Programs', 'Trae CN', 'Trae CN.exe')]
      : []
    for (const c of candidates) if (existsSync(c)) return c
  }
  return null
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
    try {
      // Deliberately no .vscode/tasks.json writing here: a persisted folderOpen
      // task fires on EVERY open of the folder in any VS Code-family editor —
      // including manual opens with the app closed — which surprised the user
      // with self-launching terminals. Terminal routing is auto-route's job
      // (ANTHROPIC_BASE_URL in the user environment), not per-project tasks.
      const exe = resolveEditorExe(settings.editorCommand)
      if (!exe) {
        return { ok: false, error: `Editor "${settings.editorCommand}" not found. Set its full path in Settings (e.g. Trae.exe).` }
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

  ipcMain.handle('tc:dock:toggle', (_e, on: boolean) => { deps.toggleDock(on); refreshTrayMenu() })
  ipcMain.handle('tc:dock:setExpanded', (_e, on: boolean) => deps.setDockExpanded(on))
  ipcMain.handle('tc:dock:setOpacity', (_e, v: number) => deps.setDockOpacity(v))
  ipcMain.handle('tc:dock:isOpen', () => deps.isDockOpen())

  return () => disconnectEvents()
}
