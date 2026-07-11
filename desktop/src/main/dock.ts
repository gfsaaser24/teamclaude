import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { logLine } from './log'
import { shouldRecreate } from './crash-backoff'
import { refreshTrayMenu } from './tray'

// A persistent, semi-transparent micro-HUD pinned to the right screen edge. It
// is a SEPARATE window from the flyout: always-on-top, never hidden on blur, and
// only ever two widths — a narrow collapsed strip or an expanded gauge panel. It
// stays anchored to the right edge as it grows/shrinks (x is recomputed from the
// new width) and vertically centered. Collapsed is wide enough for a size-32 ring
// plus padding so it works as a glanceable per-account HUD strip.
const COLLAPSED = 56
const EXPANDED = 200

let dock: BrowserWindow | null = null
// Last-applied window opacity, re-asserted whenever the dock is (re)created so a
// destroy/recreate (toggle off/on) doesn't reset the user's transparency choice.
let dockOpacity = 1
// Recreation timestamps for the crash backoff (see crash-backoff.ts) — the
// dock owns this array; the policy itself is stateless.
const recreateTimestamps: number[] = []
// Set for the duration of a deliberate destroyDock() call so a render-process-gone
// that fires as a side effect of tearing the window down isn't mistaken for a
// crash and doesn't trigger a recreate.
let intentionalTeardown = false

export function isDockOpen(): boolean {
  return dock !== null && !dock.isDestroyed()
}

/** Right-edge-anchored, vertically-centered bounds for a given width. */
function boundsFor(width: number): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay()
  const height = Math.min(Math.round(workArea.height * 0.8), 520)
  const x = workArea.x + workArea.width - width
  const y = workArea.y + Math.round((workArea.height - height) / 2)
  return { x, y, width, height }
}

export function createDock(): BrowserWindow {
  if (dock && !dock.isDestroyed()) return dock
  const win = new BrowserWindow({
    ...boundsFor(COLLAPSED),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    // NB: no backgroundMaterial here — acrylic/mica fight true transparency on
    // Win11. The glass look is done in CSS (translucent bg + backdrop-blur).
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  dock = win
  // Float above ordinary always-on-top windows (incl. the flyout) so the HUD is
  // never occluded. It is a status readout, not a focus target.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setOpacity(dockOpacity)   // re-apply the stored transparency on (re)create
  // Persistent HUD: intentionally NO 'blur' handler — it must not self-hide.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?view=dock`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'view=dock' })
  }
  win.once('ready-to-show', () => win.show())
  // Guard against a stale 'closed' (fired after destroy()) clobbering a NEWER
  // dock that a crash-recreate already assigned to the module-level `dock`.
  win.on('closed', () => {
    if (dock === win) dock = null
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    logLine('dock', `render-process-gone reason=${d.reason} exitCode=${d.exitCode}`)
    // Two guards for a deliberate destroyDock(): intentionalTeardown catches the
    // event firing synchronously from inside destroy(); `dock !== win` catches it
    // firing later (this window is no longer the current dock, whether torn down
    // or already replaced).
    if (intentionalTeardown || dock !== win) return
    const now = Date.now()
    if (!shouldRecreate(recreateTimestamps, now)) {
      logLine('dock', 'dock renderer crash loop — giving up')
      // Tear the corpse down too: otherwise isDockOpen() stays true for a dead
      // window and createDock() early-returns it, so the tray's "show dock"
      // silently no-ops. Timestamps are NOT reset — a user-initiated recreate
      // is still subject to the budget until the 60s window slides.
      destroyDock()
      // The tray's "Show edge dock (HUD)" checkbox reads isDockShown() only when
      // the menu is (re)built — without this, it stays checked after a give-up
      // until the user happens to reopen the menu for an unrelated reason.
      refreshTrayMenu()
      return
    }
    recreateTimestamps.push(now)
    destroyDock()
    // The recreated dock always starts COLLAPSED — the expanded/collapsed
    // toggle is renderer-only state and isn't preserved across a crash.
    // Opacity IS preserved (dockOpacity above is module state, re-applied).
    createDock()
  })
  return win
}

export function destroyDock(): void {
  intentionalTeardown = true
  if (dock && !dock.isDestroyed()) dock.destroy()
  dock = null
  intentionalTeardown = false
}

/** Resize between the collapsed tab and the expanded panel, staying pinned to
 *  the right edge (x follows the new width). No-op if the dock isn't open. */
export function setDockExpanded(on: boolean): void {
  if (!dock || dock.isDestroyed()) return
  dock.setBounds(boundsFor(on ? EXPANDED : COLLAPSED))
}

/** Set the dock window's opacity (whole-window alpha), clamped to a legible
 *  range so the HUD can't be dialled to invisible. Remembered and re-applied on
 *  the next (re)create. No-op on the window if the dock isn't open. */
export function setDockOpacity(value: number): void {
  dockOpacity = Math.min(1, Math.max(0.25, value))
  if (dock && !dock.isDestroyed()) dock.setOpacity(dockOpacity)
}

/** Create+show (opt-in) or tear the dock down entirely. */
export function toggleDock(on: boolean): void {
  if (on) {
    const w = createDock()
    if (!w.isVisible()) w.show()
  } else {
    destroyDock()
  }
}
