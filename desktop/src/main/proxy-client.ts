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
    return (await res.json()) as T
  }

  status(): Promise<Record<string, unknown>> { return this.json('/teamclaude/status') }
  recentEvents(): Promise<TcEvent[]> {
    return this.json<{ events: TcEvent[] }>('/teamclaude/log').then(d => d.events)
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
