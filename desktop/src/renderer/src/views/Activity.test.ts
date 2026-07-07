import { describe, it, expect } from 'vitest'
import { foldRequests } from './Activity'
import type { TcEvent } from '../types'

describe('foldRequests', () => {
  it('folds start/model/routed/end for one reqId into a single done row', () => {
    const events: TcEvent[] = [
      { id: 1, type: 'request-start', ts: 10, reqId: 7, method: 'POST', path: '/v1/messages' },
      { id: 2, type: 'request-model', ts: 11, reqId: 7, model: 'claude-opus-4' },
      { id: 3, type: 'request-routed', ts: 12, reqId: 7, account: 'work' },
      { id: 4, type: 'request-end', ts: 13, reqId: 7, status: 200 },
    ]
    const rows = foldRequests(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      reqId: 7,
      method: 'POST',
      path: '/v1/messages',
      model: 'claude-opus-4',
      account: 'work',
      status: 200,
      done: true,
    })
  })

  it('marks rows without a request-end as not done', () => {
    const events: TcEvent[] = [
      { id: 1, type: 'request-start', ts: 10, reqId: 7, method: 'GET', path: '/health' },
    ]
    const rows = foldRequests(events)
    expect(rows[0].done).toBe(false)
    expect(rows[0].status).toBeUndefined()
  })

  it('sorts rows newest-first by ts', () => {
    const events: TcEvent[] = [
      { id: 1, type: 'request-start', ts: 10, reqId: 1 },
      { id: 2, type: 'request-start', ts: 30, reqId: 3 },
      { id: 3, type: 'request-start', ts: 20, reqId: 2 },
    ]
    const rows = foldRequests(events)
    expect(rows.map(r => r.reqId)).toEqual([3, 2, 1])
  })

  it('ignores non request-* events', () => {
    const events: TcEvent[] = [
      { id: 1, type: 'oauth-complete', ts: 5, account: 'x' },
      { id: 2, type: 'request-start', ts: 10, reqId: 1, path: '/v1/messages' },
    ]
    const rows = foldRequests(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].reqId).toBe(1)
  })
})
