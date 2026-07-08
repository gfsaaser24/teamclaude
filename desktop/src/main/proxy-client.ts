import http from 'node:http'

export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }

export class ProxyClient {
  private port: number
  private apiKey: string
  private reconnectMs: number

  constructor({ port, apiKey, reconnectMs = 2000 }: { port: number; apiKey: string; reconnectMs?: number }) {
    this.port = port
    this.apiKey = apiKey
    this.reconnectMs = reconnectMs
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-api-key': this.apiKey, ...(init.headers || {}) },
      signal: AbortSignal.timeout(10_000),
    })
    // Don't assume the body is JSON: a wrong/older proxy (or an error page)
    // can answer 2xx with an empty or non-JSON body. Read text first and fail
    // with a clear message instead of a raw "Unexpected end of JSON input".
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Proxy ${path} responded ${res.status} ${res.statusText}`)
    }
    if (text.trim() === '') {
      throw new Error(`Proxy ${path} returned an empty body — is this a teamclaude build with this endpoint?`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Proxy ${path} returned a non-JSON body (${text.slice(0, 80)}…)`)
    }
  }

  status(): Promise<Record<string, unknown>> { return this.json('/teamclaude/status') }
  recentEvents(): Promise<TcEvent[]> {
    // Tolerate an older proxy without /teamclaude/log: return an empty feed
    // rather than surfacing an error for a non-fatal backfill.
    return this.json<{ events: TcEvent[] }>('/teamclaude/log')
      .then(d => d?.events ?? [])
      .catch(() => [])
  }
  reload(): Promise<{ ok: boolean; added?: number }> { return this.json('/teamclaude/reload', { method: 'POST' }) }
  oauthLogin(): Promise<{ ok: boolean; error?: string }> { return this.json('/teamclaude/oauth/login', { method: 'POST' }) }

  /**
   * Subscribe to /teamclaude/events. The hello frame's `recent` array is
   * replayed through onEvent one by one, then live events stream in.
   * Reconnects forever until the returned disconnect fn is called.
   */
  connectEvents(onEvent: (evt: TcEvent) => void): () => void {
    let stopped = false
    let req: http.ClientRequest | null = null
    let timer: NodeJS.Timeout | null = null

    const connect = (): void => {
      if (stopped) return
      req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/teamclaude/events', headers: { 'x-api-key': this.apiKey } },
        res => {
          let buf = ''
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString()
            let sep: number
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep)
              buf = buf.slice(sep + 2)
              const isHello = /^event: hello$/m.test(frame)
              const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
              if (!dataLine) continue
              try {
                const data = JSON.parse(dataLine.slice('data: '.length))
                if (isHello) for (const e of data.recent as TcEvent[]) onEvent(e)
                else onEvent(data as TcEvent)
              } catch { /* skip malformed frame */ }
            }
          })
          res.on('end', schedule)
          res.on('error', schedule)
        },
      )
      req.on('error', schedule)
    }
    const schedule = (): void => {
      if (stopped || timer) return
      timer = setTimeout(() => { timer = null; connect() }, this.reconnectMs)
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      req?.destroy()
    }
  }
}
