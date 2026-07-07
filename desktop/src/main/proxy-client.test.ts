import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { ProxyClient } from './proxy-client'

let servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise(res => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)))
}

describe('ProxyClient', () => {
  it('status() sends the api key and parses JSON', async () => {
    let gotKey = ''
    const server = createServer((req, res) => {
      gotKey = String(req.headers['x-api-key'])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ currentAccount: 'a', accounts: [] }))
    })
    const port = await listen(server)
    const client = new ProxyClient({ port, apiKey: 'sekrit' })
    const status = await client.status()
    expect(status.currentAccount).toBe('a')
    expect(gotKey).toBe('sekrit')
  })

  it('connectEvents parses SSE frames (hello recent + live) and reconnects', async () => {
    let conns = 0
    let live: ServerResponse | null = null
    const server = createServer((_req, res) => {
      conns++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: hello\ndata: ${JSON.stringify({ recent: [{ id: 1, type: 'request-end', ts: 1 }] })}\n\n`)
      live = res
    })
    const port = await listen(server)
    const client = new ProxyClient({ port, apiKey: 'k', reconnectMs: 100 })
    const events: unknown[] = []
    const disconnect = client.connectEvents(e => events.push(e))
    try {
      await new Promise(r => setTimeout(r, 300))
      expect(events).toHaveLength(1)                        // hello backfill delivered
      live!.write(`id: 2\ndata: ${JSON.stringify({ id: 2, type: 'request-start', ts: 2 })}\n\n`)
      await new Promise(r => setTimeout(r, 200))
      expect(events).toHaveLength(2)
      live!.end()                                           // server drops the stream
      await new Promise(r => setTimeout(r, 500))
      expect(conns).toBeGreaterThanOrEqual(2)               // it reconnected
    } finally { disconnect() }
  })
})
