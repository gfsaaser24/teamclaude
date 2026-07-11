import { describe, it, expect } from 'vitest'
import { shouldRecreate } from './crash-backoff'

describe('shouldRecreate', () => {
  it('allows the first 3 recreations within a 60s window', () => {
    const recent: number[] = []
    for (let i = 0; i < 3; i++) {
      const now = i * 1000
      expect(shouldRecreate(recent, now)).toBe(true)
      recent.push(now)
    }
  })

  it('blocks the 4th recreation within the same 60s window', () => {
    const recent = [0, 1000, 2000]
    expect(shouldRecreate(recent, 3000)).toBe(false)
  })

  it('allows again once the window has slid past all prior timestamps', () => {
    const recent = [0, 1000, 2000]
    expect(shouldRecreate(recent, 61000)).toBe(true)
  })

  it('only counts timestamps within the trailing 60s, ignoring older history', () => {
    // Two recreations happened 60s+ ago and no longer count; one happened 6s
    // ago and does — so only 1 of 3 is "recent", well under the budget of 3.
    const recent = [0, 1000, 55000]
    expect(shouldRecreate(recent, 61000)).toBe(true)
  })

  it('blocks exactly at the 3-recreation budget even with older entries mixed in', () => {
    // 3 timestamps all inside the trailing 60s window -> at budget -> blocked.
    const recent = [10000, 40000, 55000]
    expect(shouldRecreate(recent, 60000)).toBe(false)
  })
})
