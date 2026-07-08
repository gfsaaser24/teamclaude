import { app, globalShortcut, type Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Store from 'electron-store'
import { Supervisor } from './supervisor'
import { ProxyClient } from './proxy-client'
import { getTeamclaudeConfigPath, readTeamclaudeConfig } from './teamclaude-config'
import { registerIpc, applyAutoRoute, DEFAULT_SETTINGS, type AppSettings, type Project } from './ipc'
import { createFlyout, toggleFlyout, getFlyout, setPinned } from './flyout'
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

const store = new Store<{ settings: AppSettings; projects: Project[] }>()
let quitting = false
let tray: Tray | null = null

async function bootstrap(): Promise<void> {
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
  const proxyEntry = resolveProxyEntry()
  const proxyInfo = { port, url: `http://127.0.0.1:${port}`, configPath: getTeamclaudeConfigPath() }

  const supervisor = new Supervisor({
    command: app.isPackaged ? process.execPath : 'node',
    args: [proxyEntry, 'server', '--headless'],
    port,
    apiKey,
    // NO TEAMCLAUDE_CONFIG override → the child reads the default shared config
    // with ALL the user's settings. Only ELECTRON_RUN_AS_NODE (packaged) is set.
    env: app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
    requireCompatible: true,
  })
  const client = new ProxyClient({ port, apiKey })

  const applySettings = (s: AppSettings): void => {
    globalShortcut.unregisterAll()
    try { globalShortcut.register(s.hotkey, toggleFlyout) } catch { /* invalid accelerator — keep none */ }
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  }
  applySettings(settings)

  registerIpc({ supervisor, client, store, getFlyout, setPinned, applySettings, proxyInfo })

  // If the user turned on auto-route, re-assert it on launch (the port is
  // stable, but this keeps the env var correct if it ever changed).
  if (settings.autoRoute) void applyAutoRoute(true, proxyInfo.url)

  createFlyout()
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
  console.error('[teamclaude-desktop] bootstrap failed:', err)
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
  tray = null
})
