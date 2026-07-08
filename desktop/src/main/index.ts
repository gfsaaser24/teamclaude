import { app, globalShortcut, type Tray } from 'electron'
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
let tray: Tray | null = null

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
