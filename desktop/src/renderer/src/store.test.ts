import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// The store keeps module-level throttle/poll state (lastStatusRefresh, timers),
// so every test imports a fresh copy of the module. window.tc is stubbed with
// just the surface init()/pushEvent() touch — the store never reads window at
// import time.

type StoreModule = typeof import('./store')

async function importFreshStore(): Promise<StoreModule> {
  vi.resetModules()
  return import('./store')
}

function makeTc(): { api: { status: Mock } } {
  return {
    proxy: {
      getState: vi.fn().mockResolvedValue({ state: 'running', port: 3456 }),
      onState: vi.fn(),
    },
    api: {
      status: vi.fn().mockResolvedValue({ currentAccount: 'a', accounts: [] }),
      recentEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(),
    },
    config: { get: vi.fn().mockResolvedValue(null) },
    launcher: { list: vi.fn().mockResolvedValue([]) },
    settings: { get: vi.fn().mockResolvedValue({}) },
  } as unknown as { api: { status: Mock } }
}

let tc: ReturnType<typeof makeTc>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  tc = makeTc()
  vi.stubGlobal('window', { tc })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('pushEvent', () => {
  it('appends events and dedupes by id', async () => {
    const { useTcStore } = await importFreshStore()
    const { pushEvent } = useTcStore.getState()
    pushEvent({ id: 1, type: 'request-start', ts: 1 })
    pushEvent({ id: 2, type: 'request-end', ts: 2 })
    pushEvent({ id: 1, type: 'request-start', ts: 1 }) // duplicate (SSE reconnect replay)
    expect(useTcStore.getState().events.map(e => e.id)).toEqual([1, 2])
  })

  it('caps the buffer at 500 events', async () => {
    const { useTcStore } = await importFreshStore()
    const { pushEvent } = useTcStore.getState()
    for (let i = 1; i <= 600; i++) pushEvent({ id: i, type: 'e', ts: i })
    const events = useTcStore.getState().events
    expect(events).toHaveLength(500)
    expect(events[0].id).toBe(101)
  })
})

describe('status refresh throttle', () => {
  it('refreshes on the first request-end of a burst', async () => {
    const { useTcStore } = await importFreshStore()
    useTcStore.getState().pushEvent({ id: 1, type: 'request-end', ts: 1 })
    expect(tc.api.status).toHaveBeenCalledTimes(1)
  })

  it('a request-end inside the throttle window still lands as a trailing refresh', async () => {
    const { useTcStore } = await importFreshStore()
    useTcStore.getState().pushEvent({ id: 1, type: 'request-end', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    // Inside the 2s window — must not be dropped: the burst's last request is
    // the one whose response carried the final quota numbers.
    useTcStore.getState().pushEvent({ id: 2, type: 'request-end', ts: 2 })
    expect(tc.api.status).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(tc.api.status).toHaveBeenCalledTimes(2)
  })

  it('coalesces a rapid burst into one leading + one trailing refresh', async () => {
    const { useTcStore } = await importFreshStore()
    for (let i = 1; i <= 5; i++) {
      useTcStore.getState().pushEvent({ id: i, type: 'request-end', ts: i })
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(tc.api.status).toHaveBeenCalledTimes(2)
  })
})

describe('status poll', () => {
  it('polls status periodically so probe updates and quota resets reach idle windows', async () => {
    const { useTcStore } = await importFreshStore()
    await useTcStore.getState().init()
    tc.api.status.mockClear()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(tc.api.status).toHaveBeenCalled()
  })

  it('init() twice (StrictMode remount) starts only one poll', async () => {
    const { useTcStore } = await importFreshStore()
    await useTcStore.getState().init()
    await useTcStore.getState().init()
    tc.api.status.mockClear()
    await vi.advanceTimersByTimeAsync(30_500)
    expect(tc.api.status).toHaveBeenCalledTimes(1)
  })
})
