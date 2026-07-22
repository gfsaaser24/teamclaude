import { contextBridge, ipcRenderer } from 'electron'
import type { TcRouteDTO } from '../main/proxy-client'

function on(channel: string) {
  return (cb: (payload: never) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const tc = {
  proxy: {
    getState: () => ipcRenderer.invoke('tc:proxy:getState'),
    start: () => ipcRenderer.invoke('tc:proxy:start'),
    stop: () => ipcRenderer.invoke('tc:proxy:stop'),
    restart: () => ipcRenderer.invoke('tc:proxy:restart'),
    getInfo: () => ipcRenderer.invoke('tc:proxy:getInfo'),
    getAutoRoute: () => ipcRenderer.invoke('tc:proxy:getAutoRoute'),
    setAutoRoute: (enabled: boolean) => ipcRenderer.invoke('tc:proxy:setAutoRoute', enabled),
    onState: on('tc:proxy-state'),
  },
  api: {
    status: () => ipcRenderer.invoke('tc:api:status'),
    recentEvents: () => ipcRenderer.invoke('tc:api:recentEvents'),
    reload: () => ipcRenderer.invoke('tc:api:reload'),
    oauthLogin: () => ipcRenderer.invoke('tc:api:oauthLogin'),
    onEvent: on('tc:event'),
  },
  account: {
    // token: stable id when known, else account name (server dual-accepts).
    pin: (token: string | null) => ipcRenderer.invoke('tc:account:pin', token),
    // target: stable id when known, else name. Endpoint-backed (POST /account).
    set: (target: string, patch: { disabled?: boolean; priority?: number }) =>
      ipcRenderer.invoke('tc:account:set', target, patch),
  },
  install: {
    status: () => ipcRenderer.invoke('tc:install:status'),
    run: () => ipcRenderer.invoke('tc:install:run'),
    onLog: on('tc:install-log'),
  },
  config: {
    get: () => ipcRenderer.invoke('tc:config:get'),
    removeAccount: (name: string) => ipcRenderer.invoke('tc:config:removeAccount', name),
    setSx: (sx: { apiKey?: string; mode: string }) => ipcRenderer.invoke('tc:config:setSx', sx),
  },
  // Route config via the Phase-0 endpoints (GET/POST /teamclaude/routes) — the
  // only route path; never a config-file write, never the /status DTO.
  routes: {
    get: () => ipcRenderer.invoke('tc:routes:get') as Promise<{ supported: boolean; routes: TcRouteDTO[] }>,
    set: (routes: TcRouteDTO[]) => ipcRenderer.invoke('tc:routes:set', routes) as Promise<{ ok: boolean; supported: boolean; error?: string }>,
  },
  launcher: {
    list: () => ipcRenderer.invoke('tc:launcher:list'),
    add: (p: unknown) => ipcRenderer.invoke('tc:launcher:add', p),
    remove: (path: string) => ipcRenderer.invoke('tc:launcher:remove', path),
    open: (path: string) => ipcRenderer.invoke('tc:launcher:open', path),
    openSynara: () => ipcRenderer.invoke('tc:launcher:openSynara'),
    pickFolder: () => ipcRenderer.invoke('tc:launcher:pickFolder'),
  },
  settings: {
    get: () => ipcRenderer.invoke('tc:settings:get'),
    set: (partial: unknown) => ipcRenderer.invoke('tc:settings:set', partial),
  },
  window: {
    setPinned: (pinned: boolean) => ipcRenderer.invoke('tc:window:setPinned', pinned),
    setCompact: (on: boolean) => ipcRenderer.invoke('tc:window:setCompact', on),
    hide: () => ipcRenderer.invoke('tc:window:hide'),
    minimize: () => ipcRenderer.invoke('tc:window:minimize'),
  },
  dock: {
    toggle: (on: boolean) => ipcRenderer.invoke('tc:dock:toggle', on),
    setExpanded: (on: boolean) => ipcRenderer.invoke('tc:dock:setExpanded', on),
    setOpacity: (v: number) => ipcRenderer.invoke('tc:dock:setOpacity', v),
    isOpen: () => ipcRenderer.invoke('tc:dock:isOpen'),
  },
  // Fire-and-forget renderer -> main log line (crash reports etc.) — no reply,
  // so a broken renderer can call this without waiting on anything.
  log: (source: string, line: string): void => { ipcRenderer.send('tc:log', source, line) },
}

contextBridge.exposeInMainWorld('tc', tc)
export type TcBridge = typeof tc
