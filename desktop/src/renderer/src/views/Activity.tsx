import { useMemo, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { useTcStore } from '../store'
import type { TcEvent } from '../types'

interface RequestRow { reqId: number; ts: number; method?: string; path?: string; model?: string; account?: string; status?: number; done: boolean }

// Fold the request-* event stream into one row per request id.
export function foldRequests(events: TcEvent[]): RequestRow[] {
  const rows = new Map<number, RequestRow>()
  for (const e of events) {
    if (!e.type.startsWith('request-')) continue
    const reqId = e.reqId as number
    const row = rows.get(reqId) ?? { reqId, ts: e.ts, done: false }
    if (e.type === 'request-start') Object.assign(row, { method: e.method, path: e.path })
    if (e.type === 'request-model') row.model = e.model as string
    if (e.type === 'request-routed') row.account = e.account as string
    if (e.type === 'request-end') Object.assign(row, { status: e.status, account: e.account ?? row.account, model: e.model ?? row.model, done: true })
    rows.set(reqId, row)
  }
  return [...rows.values()].sort((a, b) => b.ts - a.ts)
}

export default function Activity(): React.JSX.Element {
  const { events } = useTcStore()
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const all = foldRequests(events)
    if (!filter) return all
    const f = filter.toLowerCase()
    return all.filter(r => [r.path, r.model, r.account, String(r.status)].some(v => v?.toLowerCase().includes(f)))
  }, [events, filter])

  return (
    <div className="space-y-2">
      <Input placeholder="Filter by path, model, account, status…" value={filter} onChange={e => setFilter(e.target.value)} className="h-8" />
      {rows.length === 0 && (
        <div className="space-y-1 rounded-2xl border border-dashed border-border px-4 py-8 text-center">
          <p className="font-serif text-sm font-normal tracking-tight">No requests yet.</p>
          <p className="font-mono text-[10px] tracking-[0.08em] uppercase text-muted-foreground">Traffic appears here once the proxy handles a request</p>
        </div>
      )}
      <ul className="space-y-1">
        {rows.slice(0, 100).map(r => (
          <li
            key={r.reqId}
            className="flex items-center gap-2 rounded-md border border-l-transparent px-2 py-1.5 font-mono text-[11px] transition-colors hover:border-l-primary hover:bg-white/[0.03]"
          >
            {!r.done ? <Badge variant="outline" className="shrink-0 animate-pulse font-mono">···</Badge>
              : <Badge variant={r.status && r.status < 400 ? 'secondary' : 'destructive'} className="shrink-0 font-mono">{r.status ?? '?'}</Badge>}
            <span className="min-w-0 flex-1 truncate" title={r.model ?? r.path ?? undefined}>{r.model ?? r.path ?? '—'}</span>
            <span className="ml-auto max-w-[35%] shrink-0 truncate text-muted-foreground" title={r.account ?? undefined}>{r.account ?? ''}</span>
            <span className="shrink-0 text-muted-foreground/70">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
