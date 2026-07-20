import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '@renderer/components/ui/select'
import { RotateCw, Play, Square, RefreshCw, ChevronLeft, ChevronRight, Zap, AppWindow } from 'lucide-react'
import { useTcStore } from '../store'
import RadialMeter from '../components/RadialMeter'
import type { TcAccountStatus } from '../types'

// Sentinel value for the switcher's "Auto-rotate" item — cannot collide with a
// real account name (teamclaude account names are email-ish, never dunder).
const AUTO = '__auto__'

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
        <RadialMeter label="Session" ratio={q.unified5h} resetMs={q.unified5hReset} size={size} stroke={stroke} showReset />
      )}
      {typeof q.unified7d === 'number' && (
        <RadialMeter label="Weekly" ratio={q.unified7d} resetMs={q.unified7dReset} size={size} stroke={stroke} showReset />
      )}
      {typeof q.unified7dFable === 'number' && (
        <RadialMeter label="Fable" ratio={q.unified7dFable} resetMs={q.unified7dFableReset} size={size} stroke={stroke} showReset />
      )}
      {typeof q.unified7dSonnet === 'number' && (
        <RadialMeter label="Sonnet" ratio={q.unified7dSonnet} resetMs={q.unified7dSonnetReset} size={size} stroke={stroke} showReset />
      )}
    </div>
  )
}

export default function Dashboard({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const { status, proxyState, events, refreshStatus, refreshConfig } = useTcStore()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try { await Promise.all([refreshStatus(), refreshConfig()]) } finally { setRefreshing(false) }
  }
  const recentEnds = events.filter(e => e.type === 'request-end').slice(-20)
  const uptime = status?.server ? Math.floor(status.server.uptimeSeconds / 60) : 0

  if (!status) {
    return (
      <div className="space-y-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="font-serif text-lg font-normal tracking-tight">Proxy is starting…</CardTitle>
          </CardHeader>
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

  // Manual pin/cycle: prev/next wraps the accounts array, seeded from the
  // current pin (manualAccount) or, when auto-rotating, the live currentAccount.
  const pinned = status.manualAccount != null
  const cycle = async (dir: -1 | 1): Promise<void> => {
    if (accounts.length === 0) return
    const cur = accounts.findIndex(a => a.name === (status.manualAccount ?? status.currentAccount))
    const base = cur >= 0 ? cur : 0
    const next = (base + dir + accounts.length) % accounts.length
    await window.tc.account.pin(accounts[next].name)
    await refreshStatus()
  }
  const goAuto = async (): Promise<void> => {
    await window.tc.account.pin(null)
    await refreshStatus()
  }
  // Direct switcher: pick any account (pin) or return to auto-rotation.
  const pick = async (v: string): Promise<void> => {
    await window.tc.account.pin(v === AUTO ? null : v)
    await refreshStatus()
  }

  return (
    <div className="space-y-3">
      {/* Quick-launch Synara — top of the Home screen. Hidden in the compact
          dock HUD (no room). Opens/focuses the Synara app (single-instance). */}
      {!compact && (
        <Button size="sm" variant="outline" className="w-full"
          onClick={() => void window.tc.launcher.openSynara()}>
          <AppWindow className="size-4" /> Open Synara
        </Button>
      )}
      {/* Active-account hero — the one thing that must survive the 300×360
          compact HUD. Mono eyebrow + serif display name over a faint clay
          identity wash; the meters sit centred underneath. */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card p-4">
        {/* Decorative clay wash along the top edge — identity, not status. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.07] to-transparent" />
        <div className="relative">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="min-w-0 truncate font-mono text-[10px] font-medium tracking-[0.14em] uppercase text-muted-foreground">
            Active account
          </span>
          <span className="ml-auto shrink-0 font-mono text-[9px] font-medium tracking-[0.12em] uppercase text-foreground-tertiary">
            {proxyState}
          </span>
          <Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground"
            aria-label="Refresh accounts" title="Refresh accounts &amp; usage"
            onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} />
          </Button>
        </div>

        <div className="mt-1 flex min-w-0 items-center">
          {/* Account switcher — the active-account name doubles as a dropdown:
              pick any account to pin it, or Auto-rotate to unpin. Trigger is
              styled as plain display text so the hero reads as typography. */}
          {accounts.length > 0 ? (
            <Select value={status.manualAccount ?? AUTO} onValueChange={v => void pick(v)}>
              <SelectTrigger
                size="sm"
                aria-label="Switch active account"
                className="-mx-1 h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 shadow-none data-[size=sm]:h-auto hover:bg-accent/40 dark:bg-transparent dark:hover:bg-accent/40"
              >
                <span
                  className={`min-w-0 truncate text-left font-serif font-normal leading-tight tracking-tight text-foreground ${compact ? 'text-xl' : 'text-2xl'}`}
                  title={status.currentAccount ?? undefined}>
                  {status.currentAccount ?? 'No active account'}
                </span>
              </SelectTrigger>
              <SelectContent position="popper" align="start" className="max-w-[280px]">
                <SelectItem value={AUTO}>
                  <span className="flex items-center gap-1.5">
                    <Zap className="size-3.5" /> Auto-rotate
                  </span>
                </SelectItem>
                <SelectSeparator />
                {accounts.map(a => (
                  <SelectItem key={a.name} value={a.name}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate">{a.name}</span>
                      {typeof a.quota.unified7d === 'number' && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {Math.round(a.quota.unified7d * 100)}% wk
                        </span>
                      )}
                      {a.disabled && <span className="shrink-0 text-[10px] text-muted-foreground">disabled</span>}
                      {a.rateLimitedUntil && <span className="shrink-0 text-[10px] text-destructive">rate-limited</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span
              className={`min-w-0 flex-1 truncate font-serif font-normal leading-tight tracking-tight ${compact ? 'text-xl' : 'text-2xl'}`}
              title={status.currentAccount ?? undefined}>
              {status.currentAccount ?? 'No active account'}
            </span>
          )}
        </div>

        {/* Manual pin / cycle — pick the active account by hand. Present in
            compact mode too (cycling by hand matters most there). Own row +
            flex-wrap so it never blows past a 240px window. */}
        {accounts.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground"
              aria-label="Pin previous account" title="Previous account"
              onClick={() => void cycle(-1)}>
              <ChevronLeft />
            </Button>
            <Button size="icon-xs" variant="ghost" className="shrink-0 text-muted-foreground"
              aria-label="Pin next account" title="Next account"
              onClick={() => void cycle(1)}>
              <ChevronRight />
            </Button>
            {pinned ? (
              <>
                <Badge variant="secondary" className="h-5 shrink-0 px-1.5 font-mono text-[9px] font-medium tracking-[0.1em] uppercase">pinned</Badge>
                <Button size="xs" variant="outline" className="shrink-0"
                  aria-label="Return to auto-rotation" title="Return to auto-rotation"
                  onClick={() => void goAuto()}>
                  <Zap /> Auto
                </Button>
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-[9px] tracking-[0.1em] uppercase text-foreground-tertiary">auto-rotating</span>
            )}
          </div>
        )}

        <div className={compact ? 'mt-3 flex justify-center' : 'mt-4 flex justify-center'}>
          {active
            ? <Gauges q={active.quota} size={compact ? 54 : 64} stroke={compact ? 6 : 6.5}
                className={compact
                  ? 'flex flex-wrap items-start justify-center gap-x-4 gap-y-2.5'
                  : 'flex flex-wrap items-start justify-center gap-x-5 gap-y-3'} />
            : <p className="text-[11px] text-muted-foreground">Waiting for quota data…</p>}
        </div>

        {!compact && (
          <div className="mt-4 space-y-2 border-t border-border/50 pt-2.5">
            <div className="truncate font-mono text-[10px] text-foreground-tertiary" title={meta}>{meta}</div>
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
      </div>

      {/* Other accounts — name on the left, a tight row of micro-gauges on the
          right. Wraps below the name when a 240px window can't fit both. */}
      {!compact && others.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-0.5 font-mono text-[10px] font-medium tracking-[0.14em] uppercase text-muted-foreground">Other accounts</div>
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
