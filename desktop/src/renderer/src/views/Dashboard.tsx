import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { RotateCw, Play, Square } from 'lucide-react'
import { useTcStore } from '../store'
import RadialMeter from '../components/RadialMeter'
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

// The 3 (+Sonnet) donut gauges for one account. Session/Weekly/Fable render
// when present; Sonnet only when the account reports it. Data mapping is
// unchanged from the old horizontal-bar cards — only the presentation moved to
// RadialMeter. The row wraps so 4 gauges still reflow inside a 240px window.
function Gauges({
  q,
  size,
  stroke,
  className = 'flex flex-wrap items-start gap-x-3 gap-y-2',
}: {
  q: TcAccountStatus['quota']
  size: number
  stroke: number
  className?: string
}): React.JSX.Element {
  if (q.unified5h == null && q.unified7d == null) {
    return <p className="text-[11px] text-muted-foreground">Waiting for quota data…</p>
  }
  return (
    <div className={className}>
      {typeof q.unified5h === 'number' && (
        <RadialMeter label="Session" ratio={q.unified5h} resetMs={q.unified5hReset} size={size} stroke={stroke} />
      )}
      {typeof q.unified7d === 'number' && (
        <RadialMeter label="Weekly" ratio={q.unified7d} resetMs={q.unified7dReset} size={size} stroke={stroke} />
      )}
      {typeof q.unified7dFable === 'number' && (
        <RadialMeter label="Fable" ratio={q.unified7dFable} resetMs={q.unified7dFableReset} size={size} stroke={stroke} />
      )}
      {typeof q.unified7dSonnet === 'number' && (
        <RadialMeter label="Sonnet" ratio={q.unified7dSonnet} resetMs={q.unified7dSonnetReset} size={size} stroke={stroke} />
      )}
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
      {/* Active-account HUD — the one thing that must survive a 240px window.
          Highlighted with a faint accent ring so it stays the focal block. */}
      <div className="rounded-xl border border-primary/25 bg-card/70 p-3 shadow-sm ring-1 ring-inset ring-primary/5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight"
            title={status.currentAccount ?? undefined}>
            {status.currentAccount ?? 'No active account'}
          </span>
          <span className="shrink-0 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{proxyState}</span>
        </div>

        <div className="mt-3 flex justify-center">
          {active
            ? <Gauges q={active.quota} size={54} stroke={6} className="flex flex-wrap items-start justify-center gap-x-4 gap-y-2.5" />
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

      {/* Other accounts — name on the left, a tight row of micro-gauges on the
          right. Wraps below the name when a 240px window can't fit both. */}
      {!compact && others.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Other accounts</div>
          {others.map(a => (
            <div key={a.name} className="rounded-lg border border-border/50 bg-card/40 px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={a.name}>{a.name}</span>
                  {a.disabled && <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">disabled</Badge>}
                  {a.status === 'error' && <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[9px]">error</Badge>}
                  {a.rateLimitedUntil && <Badge variant="destructive" className="h-4 shrink-0 px-1 text-[9px]">rate-limited</Badge>}
                </div>
                <div className="shrink-0">
                  <Gauges q={a.quota} size={40} stroke={4.5} className="flex flex-wrap items-start justify-end gap-x-2.5 gap-y-2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
