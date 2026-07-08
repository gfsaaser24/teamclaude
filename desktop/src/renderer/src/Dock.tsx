import { useEffect, useState } from 'react'
import { useTcStore } from './store'
import RadialMeter from './components/RadialMeter'
import type { TcAccountStatus } from './types'

// ── Edge dock: a semi-transparent, always-on-top micro-HUD pinned to the right
// screen edge. It collapses to a thin glass tab and expands to a per-account
// gauge grid — each account is a NUMBER + its three radial meters. The OS window
// resizes to match (window.tc.dock.setExpanded), so `expanded` here drives both
// what we render AND the physical window width. Everything is glanceable and
// tiny; the account is identified by its index, full name in a tooltip.

const GAUGE = 30
const STROKE = 4

/** The three (+ optional Sonnet) meters for one account, packed to fit 188px. */
function Meters({ q }: { q: TcAccountStatus['quota'] }): React.JSX.Element {
  const has = q.unified5h != null || q.unified7d != null || q.unified7dFable != null
  if (!has) {
    return <span className="text-[9px] leading-none text-muted-foreground/70">waiting…</span>
  }
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-1 gap-y-1">
      {typeof q.unified5h === 'number' && (
        <RadialMeter
          label="S"
          ratio={q.unified5h}
          resetMs={q.unified5hReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7d === 'number' && (
        <RadialMeter
          label="W"
          ratio={q.unified7d}
          resetMs={q.unified7dReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7dFable === 'number' && (
        <RadialMeter
          label="F"
          ratio={q.unified7dFable}
          resetMs={q.unified7dFableReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
      {typeof q.unified7dSonnet === 'number' && (
        <RadialMeter
          label="So"
          ratio={q.unified7dSonnet}
          resetMs={q.unified7dSonnetReset}
          size={GAUGE}
          stroke={STROKE}
        />
      )}
    </div>
  )
}

export default function Dock(): React.JSX.Element {
  const { status, init } = useTcStore()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    void init()
  }, [init])

  const accounts = status?.accounts ?? []
  const current = status?.currentAccount

  const toggle = (next: boolean): void => {
    setExpanded(next)
    void window.tc.dock.setExpanded(next) // resize the OS window to match
  }

  // ── Collapsed: a thin vertical glass tab, rounded on the left, flush right.
  if (!expanded) {
    return (
      <div className="flex h-screen w-screen items-stretch justify-end overflow-hidden bg-transparent">
        <button
          type="button"
          onClick={() => toggle(true)}
          aria-label="Expand dock"
          title={`Expand dock — ${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
          className="app-no-drag group relative flex w-full flex-col items-center justify-center gap-2
                     rounded-l-xl border border-r-0 border-white/12 bg-neutral-950/55 backdrop-blur-xl
                     shadow-[0_2px_16px_-4px_rgba(0,0,0,0.6)] transition-colors
                     hover:bg-neutral-900/65"
        >
          {/* left accent hairline */}
          <span
            aria-hidden
            className="absolute inset-y-3 left-0 w-px bg-gradient-to-b from-transparent via-primary/40 to-transparent"
          />
          <span
            aria-hidden
            className="text-[13px] leading-none text-foreground/70 transition-transform group-hover:-translate-x-0.5"
          >
            ‹
          </span>
          <span className="rounded-full bg-primary/15 px-1 py-1 text-[10px] font-bold tabular-nums leading-none text-foreground/90 ring-1 ring-inset ring-primary/25">
            {accounts.length}
          </span>
        </button>
      </div>
    )
  }

  // ── Expanded: a translucent glass panel listing accounts as index + meters.
  return (
    <div className="flex h-screen w-screen items-stretch justify-end overflow-hidden bg-transparent">
      <div
        className="flex w-full flex-col overflow-hidden rounded-l-xl border border-r-0 border-white/12
                      bg-neutral-950/70 backdrop-blur-xl shadow-[0_2px_24px_-6px_rgba(0,0,0,0.7)]"
      >
        {/* header — collapse control + count */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/8 px-2 py-1.5">
          <button
            type="button"
            onClick={() => toggle(false)}
            aria-label="Collapse dock"
            title="Collapse dock"
            className="app-no-drag flex size-5 items-center justify-center rounded-md text-foreground/70
                       transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <span aria-hidden className="text-[13px] leading-none">
              ›
            </span>
          </button>
          <span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
            Dock
          </span>
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
            {accounts.length}
          </span>
        </div>

        {/* account list */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-1.5">
          {accounts.length === 0 ? (
            <p className="px-1 py-3 text-center text-[10px] text-muted-foreground">
              Waiting for accounts…
            </p>
          ) : (
            <ul className="space-y-1">
              {accounts.map((a, i) => {
                const active = a.name === current
                return (
                  <li
                    key={a.name}
                    title={a.name}
                    className={`flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors ${
                      active
                        ? 'bg-primary/12 ring-1 ring-inset ring-primary/35'
                        : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    {/* index number — the account's identity at a glance */}
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold tabular-nums ${
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'bg-white/8 text-foreground/75'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Meters q={a.quota} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
