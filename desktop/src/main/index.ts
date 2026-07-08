import { app, globalShortcut, type Tray } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import Store from 'electron-store'
import { Supervisor } from './supervisor'
import { ProxyClient } from './proxy-client'
import { getTeamclaudeConfigPath } from './teamclaude-config'
import { ensureAppProxyConfig } from './app-proxy-config'
import { registerIpc, DEFAULT_SETTINGS, type AppSettings, type Project } from './ipc'
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

  // The app owns a dedicated proxy: its own config file, on its own free port,
  // seeded once from the user's shared config. This is what makes "just launch
  // it" the whole workflow — no port to reconcile, no env var, and Start/Stop
  // control a process the app actually owns.
  const appConfigPath = join(app.getPath('userData'), 'teamclaude-proxy.json')
  const prov = await ensureAppProxyConfig({ configPath: appConfigPath, sharedConfigPath: getTeamclaudeConfigPath() })
  const proxyEntry = resolveProxyEntry()
  const proxyInfo = { port: prov.port, url: `http://127.0.0.1:${prov.port}`, configPath: appConfigPath }

  // In the packaged app there's no external `node`; run the proxy with
  // Electron's own Node (ELECTRON_RUN_AS_NODE). In dev, plain `node`.
  const supervisor = new Supervisor({
    command: app.isPackaged ? process.execPath : 'node',
    args: [proxyEntry, 'server', '--headless'],
    port: prov.port,
    apiKey: prov.apiKey,
    env: {
      TEAMCLAUDE_CONFIG: appConfigPath,
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    requireCompatible: true,
  })
  const client = new ProxyClient({ port: prov.port, apiKey: prov.apiKey })

  const applySettings = (s: AppSettings): void => {
    globalShortcut.unregisterAll()
    try { globalShortcut.register(s.hotkey, toggleFlyout) } catch { /* invalid accelerator — keep none */ }
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  }
  applySettings(settings)

  registerIpc({ supervisor, client, store, getFlyout, setPinned, applySettings, proxyInfo })
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
