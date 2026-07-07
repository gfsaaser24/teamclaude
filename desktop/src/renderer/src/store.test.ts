import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTcStore } from './store'

beforeEach(() => {
  useTcStore.setState({ events: [], status: null })
  vi.stubGlobal('tc', undefined) // pushEvent must not require the bridge
})

describe('pushEvent', () => {
  it('appends events and dedupes by id', () => {
    const { pushEvent } = useTcStore.getState()
    pushEvent({ id: 1, type: 'request-start', ts: 1 })
    pushEvent({ id: 2, type: 'request-end', ts: 2 })
    pushEvent({ id: 1, type: 'request-start', ts: 1 })   // duplicate (SSE reconnect replay)
    expect(useTcStore.getState().events.map(e => e.id)).toEqual([1, 2])
  })

  it('caps the buffer at 500 events', () => {
    const { pushEvent } = useTcStore.getState()
    for (let i = 1; i <= 600; i++) pushEvent({ id: i, type: 'e', ts: i })
    const events = useTcStore.getState().events
    expect(events).toHaveLength(500)
    expect(events[0].id).toBe(101)
  })
})
