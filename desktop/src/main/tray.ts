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
