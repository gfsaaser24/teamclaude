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
