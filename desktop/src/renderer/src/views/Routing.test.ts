import { describe, it, expect } from 'vitest'
import { sanitizeRoutes, observedModels, routesFromStatus } from './Routing'
import type { TcEvent, TcStatus } from '../types'

describe('sanitizeRoutes', () => {
  it('trims, drops nameless/matchless routes, and omits empty account lists', () => {
    const out = sanitizeRoutes([
      { name: '  opus  ', match: ['claude-opus-*'], accounts: ['work'], bucket: ' 5h ' },
      { name: 'no-match', match: [] },                       // matchless → dropped
      { name: '', match: ['x'] },                            // nameless → dropped
      { name: 'all', match: ['claude-*'], accounts: [] },    // empty accounts → undefined
    ])
    expect(out).toEqual([
      { name: 'opus', match: ['claude-opus-*'], accounts: ['work'], bucket: '5h' },
      { name: 'all', match: ['claude-*'], accounts: undefined, bucket: undefined },
    ])
  })

  it('never emits a non-string account ref (the B5 corruption guard)', () => {
    const out = sanitizeRoutes([
      { name: 'r', match: ['claude-opus-*'], accounts: [{ name: 'work' } as unknown as string, 'api', ''] },
    ])
    expect(out[0].accounts).toEqual(['api'])
    // Whatever survives is a string — a display object could never reach disk.
    for (const a of out[0].accounts ?? []) expect(typeof a).toBe('string')
  })
})

describe('routesFromStatus (404-degraded read-only view)', () => {
  it('derives read-only routes from the status DTO, coercing {name,eligible} account objects to name strings', () => {
    const status = {
      routes: [
        { name: 'fable', match: ['*fable*'], accounts: [{ name: 'work', eligible: true }, 'api'], bucket: '7d' },
        { name: '', match: ['x'] },                          // nameless → dropped
        { name: 'all', match: ['claude-*'], accounts: [] },  // empty accounts → undefined
      ],
    } as unknown as TcStatus
    expect(routesFromStatus(status)).toEqual([
      { name: 'fable', match: ['*fable*'], accounts: ['work', 'api'], bucket: '7d' },
      { name: 'all', match: ['claude-*'], accounts: undefined, bucket: undefined },
    ])
  })

  it('returns [] when status is null/undefined or carries no routes', () => {
    expect(routesFromStatus(null)).toEqual([])
    expect(routesFromStatus(undefined)).toEqual([])
    expect(routesFromStatus({} as TcStatus)).toEqual([])
  })

  it('never emits a non-string account ref (display-only defense)', () => {
    const status = { routes: [{ name: 'r', match: ['claude-opus-*'], accounts: [{ name: 'max' }, 42, '', 'api'] }] } as unknown as TcStatus
    const out = routesFromStatus(status)
    expect(out[0].accounts).toEqual(['max', 'api'])
    for (const a of out[0].accounts ?? []) expect(typeof a).toBe('string')
  })
})

describe('observedModels', () => {
  it('lists distinct model ids newest-first from the event stream', () => {
    const events: TcEvent[] = [
      { id: 1, type: 'request-model', ts: 1, model: 'claude-opus-4' },
      { id: 2, type: 'request-model', ts: 2, model: 'claude-sonnet-4' },
      { id: 3, type: 'request-model', ts: 3, model: 'claude-opus-4' }, // dupe
    ]
    expect(observedModels(events)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
  })
})
