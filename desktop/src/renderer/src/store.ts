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

let lastStatusRefresh = 0

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
  },

  refreshStatus: async () => {
    try { set({ status: (await window.tc.api.status()) as TcStatus }) }
    catch { set({ status: null }) }   // proxy down — views show the down state
  },

  refreshConfig: async () => {
    try { set({ config: await window.tc.config.get() }) } catch { set({ config: null }) }
  },

  refreshProjects: async () => {
    set({ projects: await window.tc.launcher.list() })
  },

  pushEvent: (evt: TcEvent) => {
    const { events } = get()
    if (events.some(e => e.id === evt.id)) return
    const next = [...events, evt]
    set({ events: next.length > 500 ? next.slice(next.length - 500) : next })
    if ((evt.type === 'request-end' || evt.type === 'oauth-complete') && Date.now() - lastStatusRefresh > 2000) {
      lastStatusRefresh = Date.now()
      void get().refreshStatus()
      if (evt.type === 'oauth-complete') void get().refreshConfig()
    }
  },
}))
