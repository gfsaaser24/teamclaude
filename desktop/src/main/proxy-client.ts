import http from 'node:http'

export interface TcEvent { id: number; type: string; ts: number; [k: string]: unknown }

export interface TcRouteDTO { name: string; match: string[]; accounts?: string[]; bucket?: string }

/**
 * Coerce any route-account entry to a plain id/name string. The B5 corruption
 * root cause was the desktop treating `/status`'s `{name, eligible}` display
 * objects as route account refs and writing them back (they stringified to
 * "[object Object]"). Even though we now read from the dedicated routes
 * endpoint, we keep this filter as defense-in-depth: only strings survive.
 */
export function routeAccountsToStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const a of v) {
    if (typeof a === 'string') { if (a.trim()) out.push(a) }
    else if (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string') {
      const n = (a as { name: string }).name
      if (n.trim()) out.push(n) // salvage a stray display object into its name string
    }
  }
  return out.length ? out : undefined
}

/** Validate + normalize an untrusted routes array into strings-only DTOs. */
export function normalizeRoutes(raw: unknown): TcRouteDTO[] {
  if (!Array.isArray(raw)) return []
  const out: TcRouteDTO[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.name !== 'string' || !o.name.trim()) continue
    const match = Array.isArray(o.match) ? o.match.filter((m): m is string => typeof m === 'string' && m.trim() !== '') : []
    const accounts = routeAccountsToStrings(o.accounts)
    const bucket = typeof o.bucket === 'string' && o.bucket.trim() ? o.bucket : undefined
    out.push({ name: o.name, match, ...(accounts ? { accounts } : {}), ...(bucket ? { bucket } : {}) })
  }
  return out
}

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
  // Unlike json(), this never rejects: a proxy that's down, slow, or answers a
  // non-2xx/non-JSON body would otherwise surface as an unhandled IPC-handler
  // error (and, for oauth's 409 "already in flight", leave the UI spinner
  // stuck). Always resolve to an object carrying an `ok` boolean.
  private async postControl(path: string): Promise<{ ok: boolean; error?: string; added?: number }> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(10_000),
      })
      const text = await res.text()
      // The proxy returns {ok:true,...} on success and {ok:false,error} on 409;
      // parse when we can, otherwise synthesize from the HTTP status.
      try { return JSON.parse(text) } catch { return { ok: res.ok, error: res.ok ? undefined : `${res.status} ${res.statusText}` } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
  reload(): Promise<{ ok: boolean; error?: string; added?: number }> { return this.postControl('/teamclaude/reload') }
  oauthLogin(): Promise<{ ok: boolean; error?: string }> { return this.postControl('/teamclaude/oauth/login') }

  /**
   * Pin the active account, or clear the pin with `null` to return to
   * auto-rotation. `token` is the stable account id when known, falling back to
   * the account name (the server dual-accepts both during the id deprecation
   * window). Tolerant like reload/oauthLogin: a down proxy or a non-2xx/non-JSON
   * body resolves to `{ ok: false }` instead of rejecting, so the IPC handler
   * never throws and the UI can just re-read status.
   */
  pinAccount(token: string | null): Promise<{ ok: boolean; active?: string | null }> {
    const path = token == null ? '/teamclaude/pin' : `/teamclaude/pin/${encodeURIComponent(token)}`
    return this.json<{ ok: boolean; active?: string | null }>(path, { method: 'POST' }).catch(() => ({ ok: false }))
  }

  /**
   * GET /teamclaude/routes — the source of truth for route config, replacing the
   * old (corruption-prone) path of seeding from the `/status` display DTO.
   * Capability sniff BY RESPONSE, no version parsing: a 404 means an older
   * teamclaude without the endpoint → `{ supported: false }`, and the UI drops
   * to a read-only "update teamclaude" view. Network/other failures reject so
   * the caller treats them as proxy-down (not "unsupported").
   */
  async getRoutes(): Promise<{ supported: boolean; routes: TcRouteDTO[] }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/teamclaude/routes`, {
      headers: { 'x-api-key': this.apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { supported: false, routes: [] }
    const text = await res.text()
    if (!res.ok) throw new Error(`Proxy /teamclaude/routes responded ${res.status} ${res.statusText}`)
    let data: unknown
    try { data = JSON.parse(text) } catch { throw new Error('Proxy /teamclaude/routes returned a non-JSON body') }
    return { supported: true, routes: normalizeRoutes((data as { routes?: unknown } | null)?.routes) }
  }

  /**
   * POST /teamclaude/routes — the ONLY route-write path (never a config-file
   * write). Account refs are normalized to strings before sending, so a stray
   * display object can never reach disk. Tolerant: a down proxy resolves to
   * `{ ok: false }`; a 404 resolves to `{ ok: false, supported: false }` so the
   * UI can show the read-only "update teamclaude" state instead of a hard error.
   */
  async setRoutes(routes: TcRouteDTO[]): Promise<{ ok: boolean; supported: boolean; error?: string }> {
    const clean = normalizeRoutes(routes)
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/teamclaude/routes`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ routes: clean }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 404) return { ok: false, supported: false, error: 'This teamclaude build has no /routes endpoint — update teamclaude.' }
      const text = await res.text()
      if (!res.ok) return { ok: false, supported: true, error: `${res.status} ${res.statusText}` }
      try { return { ok: (JSON.parse(text) as { ok?: boolean })?.ok !== false, supported: true } } catch { return { ok: true, supported: true } }
    } catch (err) {
      return { ok: false, supported: true, error: (err as Error).message }
    }
  }

  /**
   * POST /teamclaude/account {id, disabled?, priority?} — the endpoint path for
   * account disable/priority. `target` is the stable account id when known, else
   * the name (server dual-accepts during the deprecation window). A 404 resolves
   * to `{ supported: false }` so the caller can fall back to today's config
   * write on an older server. Never throws.
   */
  async setAccount(target: string, patch: { disabled?: boolean; priority?: number }): Promise<{ ok: boolean; supported: boolean; error?: string }> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/teamclaude/account`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ id: target, ...patch }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 404) return { ok: false, supported: false, error: '404' }
      const text = await res.text()
      if (!res.ok) return { ok: false, supported: true, error: `${res.status} ${res.statusText}` }
      try { return { ok: (JSON.parse(text) as { ok?: boolean })?.ok !== false, supported: true } } catch { return { ok: true, supported: true } }
    } catch (err) {
      return { ok: false, supported: true, error: (err as Error).message }
    }
  }

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
