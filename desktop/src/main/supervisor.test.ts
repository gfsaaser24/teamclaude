import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from './supervisor'

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })

function listen(server: Server): Promise<number> {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res((server.address() as { port: number }).port)))
}

// A stand-in "proxy" script the supervisor can spawn: serves /teamclaude/status
// on the port given as argv[2].
function fakeProxyScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcd-sup-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const p = join(dir, 'fake-proxy.cjs')
  writeFileSync(p, `
    const http = require('http')
    http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type':'application/json'})
      res.end('{"accounts":[]}')
    }).listen(Number(process.argv[2]), '127.0.0.1')
  `)
  return p
}

function freePort(): Promise<number> {
  const s = createServer()
  return listen(s).then(port => new Promise(res => s.close(() => res(port))))
}

function waitState(sup: Supervisor, want: string, ms = 10000): Promise<void> {
  return new Promise((res, rej) => {
    if (sup.state === want) return res()
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${want} (at ${sup.state})`)), ms)
    sup.on('state', s => { if (s === want) { clearTimeout(t); res() } })
  })
}

describe('Supervisor', () => {
  it('attaches when something already answers on the port', async () => {
    const server = createServer((_q, r) => { r.writeHead(200); r.end('{}') })
    const port = await listen(server)
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const sup = new Supervisor({ command: process.execPath, args: ['-e', ''], port, apiKey: 'k' })
    await sup.start()
    expect(sup.state).toBe('attached')
  })

  it('does NOT attach to an incompatible proxy (no /teamclaude/log)', async () => {
    // Answers /status 200 but 404s /teamclaude/log — an older/foreign proxy.
    const server = createServer((req, res) => {
      if (req.url === '/teamclaude/log') { res.writeHead(404); res.end() }
      else { res.writeHead(200); res.end('{}') }
    })
    const port = await listen(server)
    cleanup.push(() => new Promise<void>(r => server.close(() => r())))
    const sup = new Supervisor({ command: process.execPath, args: ['-e', ''], port, apiKey: 'k', requireCompatible: true })
    await sup.start()
    expect(sup.state).not.toBe('attached')
  })

  it('spawns the child and reaches running, then stops cleanly', async () => {
    const port = await freePort()
    const script = fakeProxyScript()
    const sup = new Supervisor({ command: process.execPath, args: [script, String(port)], port, apiKey: 'k' })
    cleanup.push(() => sup.stop())
    await sup.start()
    await waitState(sup, 'running')
    await sup.stop()
    expect(sup.state).toBe('stopped')
    expect(await sup.isUp()).toBe(false)
  })

  it('marks crashed and schedules a restart when the child dies', async () => {
    const port = await freePort()
    const script = fakeProxyScript()
    const sup = new Supervisor({ command: process.execPath, args: [script, String(port)], port, apiKey: 'k' })
    cleanup.push(() => sup.stop())
    await sup.start()
    await waitState(sup, 'running')
    sup.child!.kill()
    await waitState(sup, 'crashed')
    await waitState(sup, 'running')   // backoff restart brings it back
  })
})
