import { create } from 'zustand'
import type { TcEvent, TcStatus, SupervisorState } from './types'

interface TcStore {
  proxyState: SupervisorState
  port: number
  status: TcStatus | null
  events: TcEvent[]
  config: unknown | null
  settings: Record<string, unknown> | null
  projects: { path: string; name: string; autorun: string | null }[]
  init: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshProjects: () => Promise<void>
  pushEvent: (evt: TcEvent) => void
}

// Status refreshes are throttled, but with a trailing edge: a trigger landing
// inside the window schedules ONE deferred refresh instead of being dropped.
// The last request of a burst is the one whose response carried the final
// quota numbers — dropping it froze the dock HUD at mid-burst values.
const STATUS_THROTTLE_MS = 2000
let lastStatusRefresh = 0
let trailingRefresh: ReturnType<typeof setTimeout> | null = null

function throttledStatusRefresh(refresh: () => void): void {
  const since = Date.now() - lastStatusRefresh
  if (since >= STATUS_THROTTLE_MS) {
    lastStatusRefresh = Date.now()
    refresh()
    return
  }
  if (trailingRefresh) return // a pending trailing refresh already covers this burst
  trailingRefresh = setTimeout(() => {
    trailingRefresh = null
    lastStatusRefresh = Date.now()
    refresh()
  }, STATUS_THROTTLE_MS - since)
}

// Quota also moves server-side with NO event to tell us: the background quota
// probe, quota-window resets, and usage from other devices on the same
// accounts. A slow poll keeps long-lived windows honest — the edge dock
// especially, which unlike the flyout has no user interactions to refresh it.
const STATUS_POLL_MS = 30_000
let statusPoll: ReturnType<typeof setInterval> | null = null

export const useTcStore = create<TcStore>((set, get) => ({
  proxyState: 'stopped',
  port: 3456,
  status: null,
  events: [],
  config: null,
  settings: null,
  projects: [],

  init: async () => {
    const { state, port } = await window.tc.proxy.getState()
    set({ proxyState: state, port })
    window.tc.proxy.onState(s => {
      set({ proxyState: s })
      if (s === 'running' || s === 'attached') void get().refreshStatus()
    })
    window.tc.api.onEvent(evt => get().pushEvent(evt))
    await Promise.all([get().refreshStatus(), get().refreshConfig(), get().refreshProjects()])
    const settings = await window.tc.settings.get()
    set({ settings })
    const recent = await window.tc.api.recentEvents().catch(() => [])
    for (const e of recent) get().pushEvent(e)
    // One poll per window, even when React StrictMode double-runs init().
    if (!statusPoll) {
      statusPoll = setInterval(() => throttledStatusRefresh(() => void get().refreshStatus()), STATUS_POLL_MS)
    }
  },

  refreshStatus: async () => {
    try { set({ status: (await window.tc.api.status()) as TcStatus }) }
    catch { set({ status: null }) }   // proxy down — views show the down state
  },

  refreshConfig: async () => {
    try { set({ config: await window.tc.config.get() }) } catch { set({ config: null }) }
  },

  refreshProjects: async () => {
    try { set({ projects: await window.tc.launcher.list() }) } catch { set({ projects: [] }) }
  },

  pushEvent: (evt: TcEvent) => {
    const { events } = get()
    if (events.some(e => e.id === evt.id)) return
    const next = [...events, evt]
    set({ events: next.length > 500 ? next.slice(next.length - 500) : next })
    if (evt.type === 'request-end' || evt.type === 'oauth-complete') {
      throttledStatusRefresh(() => void get().refreshStatus())
      // Config refresh is outside the throttle: oauth-complete is rare, and a
      // new account must show up even right after a request burst.
      if (evt.type === 'oauth-complete') void get().refreshConfig()
    }
  },
}))
