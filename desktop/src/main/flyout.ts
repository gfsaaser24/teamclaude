import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { logLine } from './log'

const WIDTH = 420
const MARGIN = 12
const COMPACT_WIDTH = 300
const COMPACT_HEIGHT = 360

let flyout: BrowserWindow | null = null
let userMoved = false   // once the user drags/resizes, stop snapping back to the edge
let compact = false
let prevBounds: { x: number; y: number; width: number; height: number } | null = null

export function getFlyout(): BrowserWindow | null { return flyout }
// "Pin" = keep the window above other apps. On by default (HUD companion);
// unpinned it stacks like a traditional window. (Hide-on-blur is gone, so
// this is the pin button's whole meaning now.)
export function setPinned(v: boolean): void { flyout?.setAlwaysOnTop(v) }

/**
 * Shrink the flyout into a small always-on-top HUD (active account + meters) and
 * back. We only ever change SIZE — the window keeps its current on-screen corner
 * so we never fight a position the user chose. The pre-compact size is stashed so
 * a manual resize survives the round trip. Anchored to the window's right edge so
 * a right-docked flyout hugs the same corner while it grows/shrinks.
 */
export function setCompact(on: boolean): void {
  if (!flyout) return
  const cur = flyout.getBounds()
  const { workArea } = screen.getPrimaryDisplay()
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))

  if (on) {
    if (!compact) prevBounds = cur   // remember the size to restore to
    compact = true
    const width = COMPACT_WIDTH
    const height = COMPACT_HEIGHT
    const x = clamp(cur.x + cur.width - width, workArea.x, workArea.x + workArea.width - width)
    const y = clamp(cur.y, workArea.y, workArea.y + workArea.height - height)
    flyout.setBounds({ x, y, width, height })
  } else {
    compact = false
    const width = prevBounds?.width ?? WIDTH
    const height = prevBounds?.height ?? (workArea.height - MARGIN * 2)
    prevBounds = null
    const x = clamp(cur.x + cur.width - width, workArea.x, workArea.x + workArea.width - width)
    const y = clamp(cur.y, workArea.y, workArea.y + workArea.height - height)
    flyout.setBounds({ x, y, width, height })
  }
}

export function createFlyout(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()
  flyout = new BrowserWindow({
    width: WIDTH,
    height: workArea.height - MARGIN * 2,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    show: false,
    frame: false,
    resizable: true,
    minWidth: 240,
    movable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundMaterial: 'acrylic',   // Win11 flyout look; harmless elsewhere
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // No hide-on-blur: this is a real app window — alt-tabbing away must not
  // close it. Hiding is explicit (X button, tray toggle, hotkey, minimize).
  flyout.on('moved', () => { userMoved = true })
  flyout.on('resized', () => { userMoved = true })
  flyout.webContents.on('render-process-gone', (_e, d) => {
    logLine('flyout', `render-process-gone reason=${d.reason} exitCode=${d.exitCode}`)
  })
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
  if (flyout.isMinimized()) { flyout.restore(); flyout.focus(); return }
  if (flyout.isVisible()) { flyout.hide(); return }
  // Anchor to the right edge only until the user has moved/resized it; after
  // that we respect their chosen position instead of snapping it back.
  if (!userMoved) {
    const { workArea } = screen.getPrimaryDisplay()
    flyout.setBounds({
      width: WIDTH,
      height: workArea.height - MARGIN * 2,
      x: workArea.x + workArea.width - WIDTH - MARGIN,
      y: workArea.y + MARGIN,
    })
  }
  flyout.show()
  flyout.focus()
}

export function minimizeFlyout(): void { flyout?.minimize() }
