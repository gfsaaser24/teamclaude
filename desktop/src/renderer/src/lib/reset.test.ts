import { describe, expect, it } from 'vitest'
import { resetAt, resetLong, untilReset, untilResetCompact } from './reset'

// All cases pin `now` explicitly — the helpers must never depend on wall time.
const NOW = new Date('2026-07-19T10:00:00').getTime()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('untilReset', () => {
  it('renders minutes only under an hour', () => {
    expect(untilReset(NOW + 12 * MIN, NOW)).toBe('12m')
  })
  it('renders hours + minutes under a day', () => {
    expect(untilReset(NOW + 5 * HOUR + 12 * MIN, NOW)).toBe('5h 12m')
  })
  it('renders days + hours past a day', () => {
    expect(untilReset(NOW + 2 * DAY + 5 * HOUR, NOW)).toBe('2d 5h')
  })
  it('drops the zero second unit', () => {
    expect(untilReset(NOW + 3 * DAY, NOW)).toBe('3d')
    expect(untilReset(NOW + 2 * HOUR, NOW)).toBe('2h')
  })
  it('floors an imminent reset at 1m', () => {
    expect(untilReset(NOW + 10_000, NOW)).toBe('1m')
    expect(untilReset(NOW - 10_000, NOW)).toBe('1m')
  })
})

describe('untilResetCompact', () => {
  it('picks the single dominant unit', () => {
    expect(untilResetCompact(NOW + 12 * MIN, NOW)).toBe('12m')
    expect(untilResetCompact(NOW + 5 * HOUR + 12 * MIN, NOW)).toBe('5h')
    expect(untilResetCompact(NOW + 2 * DAY + 5 * HOUR, NOW)).toBe('2d')
  })
  it('rounds to the nearest unit rather than flooring', () => {
    expect(untilResetCompact(NOW + 1 * DAY + 20 * HOUR, NOW)).toBe('2d')
    expect(untilResetCompact(NOW + 1 * HOUR + 45 * MIN, NOW)).toBe('2h')
  })
})

describe('resetAt', () => {
  it('renders time only when the reset is today', () => {
    const s = resetAt(NOW + 2 * HOUR, NOW)
    expect(s).not.toMatch(/Jul/)
    expect(s).toMatch(/12/)
  })
  it('includes weekday and date when the reset is another day', () => {
    const s = resetAt(NOW + 3 * DAY, NOW)
    expect(s).toMatch(/Wed/)
    expect(s).toMatch(/Jul/)
    expect(s).toMatch(/22/)
  })
})

describe('resetLong', () => {
  it('combines the countdown and the absolute moment', () => {
    const s = resetLong(NOW + 2 * DAY + 5 * HOUR, NOW)
    expect(s).toMatch(/^resets in 2d 5h \(/)
    expect(s).toMatch(/Jul/)
  })
})
