import { app, globalShortcut, type Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import Store from 'electron-store'
import { initFileLog, logLine } from './log'
import { Supervisor } from './supervisor'
import { ProxyClient } from './proxy-client'
import { getTeamclaudeConfigPath, readTeamclaudeConfig } from './teamclaude-config'
import { registerIpc, applyAutoRoute, DEFAULT_SETTINGS, type AppSettings, type Project } from './ipc'
import { isTeamclaudeInstalled, preferredProxyLaunch } from './teamclaude-install'
import { createFlyout, toggleFlyout, getFlyout, setPinned, setCompact } from './flyout'
import { toggleDock, setDockExpanded, setDockOpacity, isDockOpen, destroyDock } from './dock'
import { createTray } from './tray'

/** Locate the teamclaude proxy entry the app runs — bundled in the packaged
 *  app, or the repo checkout in dev. */
function resolveProxyEntry(): string {
  const candidates = [
    join(process.resourcesPath, 'app-proxy', 'index.js'),   // packaged: extraResources
    join(app.getAppPath(), '..', 'src', 'index.js'),
    join(process.cwd(), 'src', 'index.js'),
    join(process.cwd(), '..', 'src', 'index.js'),
    'C:/code/teamclaude/src/index.js',
  ]
  return candidates.find(c => existsSync(c)) ?? candidates[0]
}

if (!app.requestSingleInstanceLock()) app.quit()

// One-time migration: the app was originally misnamed "desktop" (the generic
// scaffold package.json name), so settings lived in %APPDATA%/desktop. Now that
// it has a real name, copy the old settings into the new userData dir once.
function migrateLegacyUserData(): void {
  try {
    const target = join(app.getPath('userData'), 'config.json')
    if (existsSync(target)) return
    const legacy = join(app.getPath('appData'), 'desktop', 'config.json')
    if (!existsSync(legacy)) return
    mkdirSync(app.getPath('userData'), { recursive: true })
    copyFileSync(legacy, target)
  } catch { /* fresh defaults are an acceptable fallback */ }
}
migrateLegacyUserData()

const store = new Store<{ settings: AppSettings; projects: Project[] }>()
let quitting = false
let tray: Tray | null = null

async function bootstrap(): Promise<void> {
  initFileLog(app.getPath('userData'))
  logLine('app', `started v${app.getVersion()} packaged=${app.isPackaged} exec=${process.execPath}`)
  electronApp.setAppUserModelId('com.teamclaude.desktop')
  app.on('browser-window-created', (_e, win) => optimizer.watchWindowShortcuts(win))

  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...store.get('settings', DEFAULT_SETTINGS) }

  // The app IS the user's teamclaude: it runs the proxy against the SAME shared
  // config (~/.config/teamclaude.json), same port and same settings — accounts,
  // switchThreshold, quotaProbeSeconds, routes, sx — so it behaves exactly like
  // `teamclaude server`, not a stripped-down copy.
  const cfg = await readTeamclaudeConfig()
  const port = cfg?.proxy.port ?? 3456
  const apiKey = cfg?.proxy.apiKey ?? ''
  const proxyInfo = { port, url: `http://127.0.0.1:${port}`, configPath: getTeamclaudeConfigPath() }

  // Prefer running the user's REAL global `teamclaude` (installed via npm) so the
  // app stays identical to the CLI; fall back to the bundled proxy entry only
  // when no global install is available.
  const installed = await isTeamclaudeInstalled()
  const bundledEntry = resolveProxyEntry()
  const launch = preferredProxyLaunch({
    installed,
    isPackaged: app.isPackaged,
    bundledEntry,
    packagedNode: process.execPath,
  })

  const supervisor = new Supervisor({
    command: launch.command,
    args: launch.args,
    port,
    apiKey,
    // NO TEAMCLAUDE_CONFIG override → the child reads the default shared config
    // with ALL the user's settings. When falling back to the bundled entry in a
    // packaged app, launch.env carries ELECTRON_RUN_AS_NODE.
    env: launch.env,
    requireCompatible: true,
    // Neutral cwd: never let the proxy child inherit the app's own working
    // directory (the install folder when launched from a shortcut), which
    // would hold a CWD lock on it and break rebuilds/uninstalls.
    cwd: app.getPath('userData'),
  })
  const client = new ProxyClient({ port, apiKey })

  supervisor.on('state', s => logLine('supervisor', `state -> ${String(s)}`))
  supervisor.on('log', (line: string) => logLine('proxy', line))

  const applySettings = (s: AppSettings): void => {
    globalShortcut.unregisterAll()
    try { globalShortcut.register(s.hotkey, toggleFlyout) } catch { /* invalid accelerator — keep none */ }
    // Only manage the login item from a packaged build: in dev process.execPath
    // is the bare electron binary, and registering it litters the user's
    // autostart with a broken entry that launches an empty Electron shell.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  }
  applySettings(settings)

  registerIpc({ supervisor, client, store, getFlyout, setPinned, setCompact, toggleDock, setDockExpanded, setDockOpacity, isDockOpen, applySettings, proxyInfo })

  // If the user turned on auto-route, re-assert it on launch (the port is
  // stable, but this keeps the env var correct if it ever changed).
  if (settings.autoRoute) void applyAutoRoute(true, proxyInfo.url)

  createFlyout()
  // Seed the stored opacity first so it's applied the moment the dock is created.
  setDockOpacity(settings.dockOpacity ?? DEFAULT_SETTINGS.dockOpacity ?? 1)
  if (settings.showDock) toggleDock(true)   // opt-in persistent edge dock (micro-HUD)
  tray = createTray({ supervisor, onToggle: toggleFlyout, onQuit: () => app.quit() })

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

app.whenReady().then(bootstrap).catch(err => {
  logLine('app', `bootstrap failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  console.error('[teamclaude-desktop] bootstrap failed:', err)
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  destroyDock()
  tray?.destroy()
  tray = null
})
