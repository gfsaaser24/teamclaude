import { ipcMain, dialog, BrowserWindow } from 'electron'
import { spawn, execSync } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
      const exe = resolveEditorExe(settings.editorCommand)
      if (!exe) {
        return { ok: false, error: `Editor "${settings.editorCommand}" not found. Set its full path in Settings (e.g. Trae.exe).` }
      }
      // A .cmd/.bat shim needs a shell; a real .exe is launched directly so a
      // failure surfaces as an error rather than being swallowed by the shell.
      const useShell = /\.(cmd|bat)$/i.test(exe)
      const child = spawn(exe, [path], { shell: useShell, detached: true, stdio: 'ignore' })
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

  ipcMain.handle('tc:window:setPinned', (_e, pinned: boolean) => deps.setPinned(pinned))
  ipcMain.handle('tc:window:hide', () => deps.getFlyout()?.hide())

  return () => disconnectEvents()
}
