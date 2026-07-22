import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http'
import { ProxyClient, normalizeRoutes, routeAccountsToStrings } from './proxy-client'

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString()
}

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

describe('normalizeRoutes / routeAccountsToStrings', () => {
  it('coerces {name,eligible} display objects to plain name strings (B5 defense)', () => {
    expect(routeAccountsToStrings([{ name: 'work', eligible: true }, 'api', { name: '  ' }, 42]))
      .toEqual(['work', 'api'])
  })
  it('drops nameless routes, filters non-string matches, and strips empty accounts', () => {
    const out = normalizeRoutes([
      { name: 'opus', match: ['claude-opus-*', 7], accounts: [{ name: 'max' }, 'work'], bucket: '5h' },
      { name: '', match: ['x'] },                 // nameless → dropped
      { match: ['y'] },                            // no name → dropped
      { name: 'empty', match: ['z'], accounts: [] }, // empty accounts → omitted
    ])
    expect(out).toEqual([
      { name: 'opus', match: ['claude-opus-*'], accounts: ['max', 'work'], bucket: '5h' },
      { name: 'empty', match: ['z'] },
    ])
  })
})

describe('ProxyClient.getRoutes', () => {
  it('reads + normalizes routes and sends the api key', async () => {
    let gotKey = ''
    const server = createServer((req, res) => {
      gotKey = String(req.headers['x-api-key'])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ routes: [{ name: 'r', match: ['claude-opus-*'], accounts: [{ name: 'work', eligible: true }] }] }))
    })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).getRoutes()
    expect(gotKey).toBe('k')
    expect(r.supported).toBe(true)
    expect(r.routes).toEqual([{ name: 'r', match: ['claude-opus-*'], accounts: ['work'] }])
  })

  it('treats a 404 as an older server without the endpoint (supported:false)', async () => {
    const server = createServer((_req, res) => { res.writeHead(404); res.end('not found') })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).getRoutes()
    expect(r).toEqual({ supported: false, routes: [] })
  })
})

describe('ProxyClient.setRoutes', () => {
  it('POSTs strings-only accounts as {routes} with the api key', async () => {
    let body = ''
    let gotKey = ''
    let method = ''
    const server = createServer(async (req, res) => {
      gotKey = String(req.headers['x-api-key'])
      method = String(req.method)
      body = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const port = await listen(server)
    // A stray display object in accounts must be stripped to a string before it
    // can reach disk — the whole point of the B5 fix.
    const r = await new ProxyClient({ port, apiKey: 'k' }).setRoutes([
      { name: 'r', match: ['claude-opus-*'], accounts: [{ name: 'work' } as unknown as string] },
    ])
    expect(r).toEqual({ ok: true, supported: true })
    expect(method).toBe('POST')
    expect(gotKey).toBe('k')
    expect(JSON.parse(body)).toEqual({ routes: [{ name: 'r', match: ['claude-opus-*'], accounts: ['work'] }] })
  })

  it('resolves supported:false on a 404 (older server)', async () => {
    const server = createServer((_req, res) => { res.writeHead(404); res.end() })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).setRoutes([])
    expect(r.ok).toBe(false)
    expect(r.supported).toBe(false)
  })
})

describe('ProxyClient.setAccount', () => {
  it('POSTs {id, disabled?, priority?} with the api key', async () => {
    let body = ''
    let gotKey = ''
    const server = createServer(async (req, res) => {
      gotKey = String(req.headers['x-api-key'])
      body = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).setAccount('acct-1', { disabled: true })
    expect(r).toEqual({ ok: true, supported: true })
    expect(gotKey).toBe('k')
    expect(JSON.parse(body)).toEqual({ id: 'acct-1', disabled: true })
  })

  it('resolves supported:false on a 404 so the caller can fall back', async () => {
    const server = createServer((_req, res) => { res.writeHead(404); res.end() })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).setAccount('work', { priority: 3 })
    expect(r.supported).toBe(false)
  })

  it('surfaces a 400 unknown_account as an error with supported:true (endpoint exists → no fallback)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unknown_account' }))
    })
    const port = await listen(server)
    const r = await new ProxyClient({ port, apiKey: 'k' }).setAccount('ghost', { disabled: true })
    expect(r.supported).toBe(true)  // NOT 404 → the caller must not fall back to a config write
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unknown_account') // body error surfaced verbatim to the renderer
  })
})
