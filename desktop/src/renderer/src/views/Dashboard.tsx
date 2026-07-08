import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { RotateCw, Play, Square } from 'lucide-react'
import { useTcStore } from '../store'
import QuotaBar from '../components/QuotaBar'
import type { TcAccountStatus } from '../types'

// Proxy state → status-dot colour. Keeps the HUD readable at a glance even when
// the window is shrunk to 240px and the badge text is the only other signal.
const STATE_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  attached: 'bg-sky-500',
  starting: 'bg-amber-500',
  crashed: 'bg-destructive',
  stopped: 'bg-muted-foreground',
}

// The 3 (+Sonnet) meters for one account. Session/Weekly/Fable always render
// when present; Sonnet only when the account reports it. Data mapping is
// unchanged from the per-account cards.
function Meters({ q }: { q: TcAccountStatus['quota'] }): React.JSX.Element {
  if (q.unified5h == null && q.unified7d == null) {
    return <p className="text-[11px] text-muted-foreground">Waiting for quota data…</p>
  }
  return (
    <div className="space-y-2">
      {typeof q.unified5h === 'number' && <QuotaBar label="Session" ratio={q.unified5h} resetMs={q.unified5hReset} />}
      {typeof q.unified7d === 'number' && <QuotaBar label="Weekly" ratio={q.unified7d} resetMs={q.unified7dReset} />}
      {typeof q.unified7dFable === 'number' && <QuotaBar label="Fable" ratio={q.unified7dFable} resetMs={q.unified7dFableReset} />}
      {typeof q.unified7dSonnet === 'number' && <QuotaBar label="Sonnet" ratio={q.unified7dSonnet} resetMs={q.unified7dSonnetReset} />}
    </div>
  )
}

export default function Dashboard({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { status, proxyState, events } = useTcStore()
  const recentEnds = events.filter(e => e.type === 'request-end').slice(-20)
  const uptime = status?.server ? Math.floor(status.server.uptimeSeconds / 60) : 0

  if (!status) {
    return (
      <div className="space-y-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Proxy is starting…</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              State: {proxyState}. If it stays down, use the buttons below.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void window.tc.proxy.start()}><Play className="size-4" /> Start</Button>
              <Button size="sm" variant="outline" onClick={() => void window.tc.proxy.restart()}><RotateCw className="size-4" /> Restart</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const accounts = status.accounts ?? []
  const active = accounts.find(a => a.name === status.currentAccount) ?? null
  const others = accounts.filter(a => a.name !== active?.name)
  const dot = STATE_DOT[proxyState] ?? STATE_DOT.stopped
  const meta = `port ${status.server?.port ?? '—'} · up ${uptime}m · ${recentEnds.length} req`

  return (
    <div className="space-y-3">
      {/* Active-account HUD — the one thing that must survive a 240px window. */}
      <div className="rounded-xl border border-border/60 bg-card/70 p-3 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight"
            title={status.currentAccount ?? undefined}>
            {status.currentAccount ?? 'No active account'}
          </span>
          <span className="shrink-0 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{proxyState}</span>
        </div>

        <div className="mt-3">
          {active
            ? <Meters q={active.quota} />
            : <p className="text-[11px] text-muted-foreground">Waiting for quota data…</p>}
        </div>

        {!compact && (
          <div className="mt-3 space-y-2 border-t border-border/50 pt-2.5">
            <div className="truncate text-[10px] text-muted-foreground" title={meta}>{meta}</div>
            <div className="flex gap-1.5">
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void window.tc.api.reload()}>
                <RotateCw /> Reload
              </Button>
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void window.tc.proxy.stop()}>
                <Square /> Stop
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Other accounts — denser than the HUD, hidden entirely in compact mode. */}
      {!compact && others.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Other accounts</div>
          {others.map(a => (
            <div key={a.name} className="rounded-lg border border-border/50 bg-card/40 p-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={a.name}>{a.name}</span>
                {a.disabled && <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">disabled</Badge>}
                {a.status === 'error' && <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[9px]">error</Badge>}
                {a.rateLimitedUntil && <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[9px]">rate-limited</Badge>}
              </div>
              <div className="mt-1.5"><Meters q={a.quota} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
